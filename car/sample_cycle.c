#include "config.h"
#include "sample_cycle.h"
#include "hcsr04.h"
#include "line_follow.h"
#include "uart.h"
#include <avr/pgmspace.h>

#define CODE_NOT_READ 0xFFU

static sample_phase_t cycle_phase;
static uint8_t armed, near_object, clearing, dht_done, light_done, succeeded;
static uint8_t dht_attempts, dht_code, lux_code;
static uint8_t classification, confidence = UART_NO_CONFIDENCE;
static uint32_t phase_started, clear_started;
static int16_t sample_temp_c;
static uint8_t sample_humidity;
static uint16_t sample_lux;
static uint16_t stop_count;

void sample_cycle_init(void)
{
    cycle_phase = SAMPLE_DRIVING;
    armed = 1;
    near_object = clearing = dht_done = light_done = succeeded = 0;
}

uint8_t sample_cycle_observe(uint16_t distance_cm, uint32_t now)
{
    near_object = distance_cm != HCSR04_INVALID_CM && distance_cm <= OBSTACLE_DISTANCE_CM;
    if (cycle_phase != SAMPLE_DRIVING) return 0;
    if (!armed) {
        /* A side-looking sensor has no echo when it faces open space. Require
         * sustained clearance, with hysteresis, before accepting another object. */
        uint8_t clear = distance_cm == HCSR04_INVALID_CM ||
                        distance_cm > OBJECT_CLEAR_DISTANCE_CM;
        if (!clear) clearing = 0;
        else if (!clearing) { clear_started = now; clearing = 1; }
        else if ((uint32_t)(now - clear_started) >= OBJECT_CLEAR_TIME_MS) {
            armed = 1;
            clearing = 0;
            dbg_msg('d', PSTR("object cleared, detection re-armed"));
        }
    }
    if (!armed || !near_object) return 0;
    armed = clearing = dht_done = light_done = dht_attempts = 0;
    dht_code = lux_code = CODE_NOT_READ;
    succeeded = 1;
    cycle_phase = SAMPLE_ACQUIRING;
    phase_started = now;
    line_follow_set_paused(1, now);

    dbg_t d;
    dbg_start(&d, 'i');
    dbg_p(&d, PSTR("stop #"));
    dbg_u(&d, ++stop_count);
    dbg_p(&d, PSTR(": object at "));
    dbg_u(&d, distance_cm);
    dbg_p(&d, PSTR(" cm, motors held"));
    dbg_send(&d);
    return 1;
}

static void log_verdict(uint8_t verdict, uint8_t percent)
{
    dbg_t d;
    dbg_start(&d, verdict == 'E' || verdict == 0 ? 'w' : 'i');
    if (verdict == 0) {
        dbg_p(&d, PSTR("no verdict from ESP32 within "));
        dbg_u(&d, (uint16_t)(CLASSIFY_TIMEOUT_MS / 1000UL));
        dbg_p(&d, PSTR(" s"));
    } else {
        dbg_p(&d, PSTR("verdict received: "));
        dbg_p(&d, verdict == 'T' ? PSTR("TREE")
                  : verdict == 'O' ? PSTR("OBJECT")
                  : verdict == 'U' ? PSTR("UNCLEAR")
                                   : PSTR("ERROR"));
        if (percent != UART_NO_CONFIDENCE) {
            dbg_p(&d, PSTR(" ("));
            dbg_u(&d, percent);
            dbg_p(&d, PSTR("%)"));
        }
    }
    dbg_send(&d);
}

void sample_cycle_update(uint32_t now)
{
    uint8_t reply_confidence;
    uint8_t reply = uart_take_classification(&reply_confidence);
    if (reply && (cycle_phase == SAMPLE_READINGS || cycle_phase == SAMPLE_CLASSIFYING)) {
        classification = reply;
        confidence = reply_confidence;
        log_verdict(reply, reply_confidence);
    } else if (reply) {
        dbg_msg('w', PSTR("late verdict ignored (not waiting for one)"));
    }

    if (cycle_phase == SAMPLE_ACQUIRING) {
        if ((!dht_done || !light_done) &&
            (uint32_t)(now - phase_started) < SAMPLE_ACQUIRE_TIMEOUT_MS) return;
        if (!dht_done || !light_done) {
            succeeded = 0;
            dbg_msg('w', PSTR("acquire timeout, sending what we have"));
        }
        /* Drop any late reply from a previous stop before asking about this one. */
        (void)uart_take_classification(0);
        classification = 0;
        confidence = UART_NO_CONFIDENCE;
        /* Motors are held; this transition runs exactly once per sampling stop. */
        if (succeeded) {
            uart_send_sample(sample_temp_c, sample_humidity, sample_lux);
            dbg_msg('i', PSTR("sent readings to ESP32, waiting for photo verdict"));
        } else {
            uart_send_sample_failed(dht_code, lux_code);
            dbg_msg('w', PSTR("sent FAILED sample to ESP32 (see dht/lux codes)"));
        }
        cycle_phase = SAMPLE_READINGS;
        phase_started = now;
    } else if (cycle_phase == SAMPLE_READINGS &&
               (uint32_t)(now - phase_started) >= SAMPLE_READINGS_TIME_MS) {
        cycle_phase = SAMPLE_CLASSIFYING;
        phase_started = now;
    } else if (cycle_phase == SAMPLE_CLASSIFYING &&
               (classification ||
                (uint32_t)(now - phase_started) >= CLASSIFY_TIMEOUT_MS)) {
        if (!classification) log_verdict(0, UART_NO_CONFIDENCE);
        cycle_phase = SAMPLE_RESULT;
        phase_started = now;
    } else if (cycle_phase == SAMPLE_RESULT &&
               (uint32_t)(now - phase_started) >= SAMPLE_RESULT_TIME_MS) {
        cycle_phase = SAMPLE_DRIVING;
        /* Keep the object disarmed until the rover has driven past it. */
        clearing = 0;
        line_follow_set_paused(0, now);
        dbg_msg('i', PSTR("resume line following"));
    }
}

sample_phase_t sample_cycle_phase(void) { return cycle_phase; }
uint8_t sample_cycle_near_object(void) { return near_object; }
uint8_t sample_cycle_needs_dht(uint32_t now)
{
    /* Let the supply settle after braking before the timing-critical DHT11 transaction. */
    return cycle_phase == SAMPLE_ACQUIRING && !dht_done &&
           (uint32_t)(now - phase_started) >= SAMPLE_DHT_SETTLE_MS;
}
uint8_t sample_cycle_needs_light(uint32_t now)
{
    return cycle_phase == SAMPLE_ACQUIRING && !light_done &&
           (uint32_t)(now - phase_started) >= SAMPLE_LIGHT_SETTLE_MS;
}
void sample_cycle_dht_done(uint8_t code, int16_t temp_c, uint8_t humidity)
{
    if (cycle_phase != SAMPLE_ACQUIRING || dht_done) return;
    dht_attempts++;
    dht_code = code;
    if (code != 0 && dht_attempts < DHT11_MAX_ATTEMPTS) return; /* retry after the interval */
    dht_done = 1;
    sample_temp_c = temp_c;
    sample_humidity = humidity;
    if (code != 0) succeeded = 0;
}
void sample_cycle_light_done(uint8_t success, uint16_t lux)
{
    if (cycle_phase != SAMPLE_ACQUIRING || light_done) return;
    light_done = 1;
    lux_code = success ? 0 : 1;
    sample_lux = lux;
    if (!success) succeeded = 0;
}
uint8_t sample_cycle_succeeded(void) { return succeeded; }
uint8_t sample_cycle_classification(void) { return classification; }
uint8_t sample_cycle_confidence(void) { return confidence; }
