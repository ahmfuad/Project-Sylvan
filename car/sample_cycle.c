#include "config.h"
#include "sample_cycle.h"
#include "hcsr04.h"
#include "line_follow.h"
#include "uart.h"

static sample_phase_t cycle_phase;
static uint8_t armed, near_object, clearing, dht_done, light_done, succeeded;
static uint8_t classification;
static uint32_t phase_started, clear_started;
static int16_t sample_temp_c;
static uint8_t sample_humidity;
static uint16_t sample_lux;

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
        }
    }
    if (!armed || !near_object) return 0;
    armed = clearing = dht_done = light_done = 0;
    succeeded = 1;
    cycle_phase = SAMPLE_ACQUIRING;
    phase_started = now;
    line_follow_set_paused(1, now);
    return 1;
}

void sample_cycle_update(uint32_t now)
{
    uint8_t reply = uart_take_classification();
    if (reply && (cycle_phase == SAMPLE_READINGS || cycle_phase == SAMPLE_CLASSIFYING))
        classification = reply;

    if (cycle_phase == SAMPLE_ACQUIRING) {
        if ((!dht_done || !light_done) &&
            (uint32_t)(now - phase_started) < SAMPLE_ACQUIRE_TIMEOUT_MS) return;
        if (!dht_done || !light_done) succeeded = 0;
        /* Drop any late reply from a previous stop before asking about this one. */
        (void)uart_take_classification();
        classification = 0;
        /* Motors are held; this transition runs exactly once per sampling stop. */
        if (succeeded) uart_send_sample(sample_temp_c, sample_humidity, sample_lux);
        else uart_send_sample_failed();
        cycle_phase = SAMPLE_READINGS;
        phase_started = now;
    } else if (cycle_phase == SAMPLE_READINGS &&
               (uint32_t)(now - phase_started) >= SAMPLE_READINGS_TIME_MS) {
        cycle_phase = SAMPLE_CLASSIFYING;
        phase_started = now;
    } else if (cycle_phase == SAMPLE_CLASSIFYING &&
               (classification ||
                (uint32_t)(now - phase_started) >= CLASSIFY_TIMEOUT_MS)) {
        cycle_phase = SAMPLE_RESULT;
        phase_started = now;
    } else if (cycle_phase == SAMPLE_RESULT &&
               (uint32_t)(now - phase_started) >= SAMPLE_RESULT_TIME_MS) {
        cycle_phase = SAMPLE_DRIVING;
        /* Keep the object disarmed until the rover has driven past it. */
        clearing = 0;
        line_follow_set_paused(0, now);
    }
}

sample_phase_t sample_cycle_phase(void) { return cycle_phase; }
uint8_t sample_cycle_near_object(void) { return near_object; }
uint8_t sample_cycle_needs_dht(void) { return cycle_phase == SAMPLE_ACQUIRING && !dht_done; }
uint8_t sample_cycle_needs_light(uint32_t now)
{
    return cycle_phase == SAMPLE_ACQUIRING && !light_done &&
           (uint32_t)(now - phase_started) >= SAMPLE_LIGHT_SETTLE_MS;
}
void sample_cycle_dht_done(uint8_t success, int16_t temp_c, uint8_t humidity)
{
    if (cycle_phase != SAMPLE_ACQUIRING || dht_done) return;
    dht_done = 1;
    sample_temp_c = temp_c;
    sample_humidity = humidity;
    succeeded &= success != 0;
}
void sample_cycle_light_done(uint8_t success, uint16_t lux)
{
    if (cycle_phase != SAMPLE_ACQUIRING || light_done) return;
    light_done = 1;
    sample_lux = lux;
    succeeded &= success != 0;
}
uint8_t sample_cycle_succeeded(void) { return succeeded; }
uint8_t sample_cycle_classification(void) { return classification; }
