#include "config.h"
#include "motor.h"
#include "line_sensor.h"
#include "line_follow.h"
#include "timebase.h"
#if INTEGRATION_STAGE >= 2
#include "twi.h"
#include "oled.h"
#include <stdlib.h>
#include <string.h>
#endif
#if INTEGRATION_STAGE >= 6
#include "sample_cycle.h"
#include "uart.h"
#include <avr/io.h>
#include <avr/pgmspace.h>

/* Debug trail: reset cause, heartbeat and line-lost transitions (see uart.h for the format). */
static void log_boot(uint8_t reset_flags)
{
    dbg_t d;
    /* A brown-out reset means the 5 V rail sagged (e.g. motor current): worth a warning. */
    dbg_start(&d, (reset_flags & (1 << BORF)) ? 'w' : 'i');
    dbg_p(&d, PSTR("ATmega boot, reset:"));
    if (reset_flags & (1 << PORF)) dbg_p(&d, PSTR(" power-on"));
    if (reset_flags & (1 << EXTRF)) dbg_p(&d, PSTR(" reset-pin"));
    if (reset_flags & (1 << BORF)) dbg_p(&d, PSTR(" BROWN-OUT"));
    if (reset_flags & (1 << WDRF)) dbg_p(&d, PSTR(" watchdog"));
    if (reset_flags & (1 << JTRF)) dbg_p(&d, PSTR(" jtag"));
    if (!(reset_flags & 0x1F)) dbg_p(&d, PSTR(" unknown"));
    dbg_send(&d);
}

static void log_heartbeat(uint32_t now)
{
    static const char phases[] PROGMEM = "DARCS"; /* driving acquiring readings classifying result */
    dbg_t d;
    dbg_start(&d, 'd');
    dbg_p(&d, PSTR("hb up="));
    dbg_u(&d, (uint16_t)(now / 1000UL));
    dbg_p(&d, PSTR("s phase="));
    char phase[2] = { (char)pgm_read_byte(&phases[sample_cycle_phase()]), 0 };
    dbg_s(&d, phase);
    dbg_p(&d, line_follow_is_lost() ? PSTR(" line=LOST") : PSTR(" line=ok"));
    dbg_p(&d, PSTR(" i2cErr="));
    dbg_u(&d, twi_error_count());
    dbg_p(&d, PSTR(" logDrop="));
    dbg_u(&d, dbg_dropped());
    dbg_send(&d);
}

static void update_trail(uint32_t now)
{
    static uint32_t heartbeat_at;
    static uint8_t was_lost;
    uint8_t lost = line_follow_is_lost();
    if (lost != was_lost) {
        was_lost = lost;
        dbg_msg(lost ? 'w' : 'i', lost ? PSTR("line lost: search timed out, motors stopped")
                                       : PSTR("line found again, following"));
    }
    if ((uint32_t)(now - heartbeat_at) >= DEBUG_HEARTBEAT_MS) {
        heartbeat_at = now;
        log_heartbeat(now);
    }
}
#endif

#if INTEGRATION_STAGE >= 4
#include "dht11.h"
static uint8_t temperature, humidity, dht_status;
static uint32_t dht_sampled_at;
#endif
#if INTEGRATION_STAGE >= 3
#include "bh1750.h"
static uint16_t lux;
static uint8_t light_status; /* 0 = pending, 1 = valid, 2 = error */
static uint32_t light_attempt;
#if INTEGRATION_STAGE < 6
static uint32_t light_read;
#endif
#endif

#if INTEGRATION_STAGE >= 5
#include "hcsr04.h"
static uint16_t distance = HCSR04_INVALID_CM;
static uint8_t distance_status;
static uint32_t ping_started;

static uint8_t update_distance(uint32_t now)
{
#if INTEGRATION_STAGE >= 6
    if (sample_cycle_phase() != SAMPLE_DRIVING) return 0;
#endif
    if ((uint32_t)(now - ping_started) < HCSR04_INTERVAL_MS) return 0;
    ping_started = now;
    motor_stop();
    timebase_pause();
    distance = hcsr04_get_distance_cm();
    timebase_resume();
    distance_status = distance == HCSR04_INVALID_CM ? 2 : 1;
#if INTEGRATION_STAGE >= 6
    if (sample_cycle_observe(distance, timebase_millis())) {
        dht_status = light_status = 0; /* Require fresh readings for this object. */
    }
#endif
    return 1;
}
#endif

#if INTEGRATION_STAGE >= 3
static uint8_t update_environment(uint32_t now)
{
#if INTEGRATION_STAGE >= 4
    if (
#if INTEGRATION_STAGE >= 6
        sample_cycle_needs_dht(now) &&
#endif
        (uint32_t)(now - dht_sampled_at) >= DHT11_INTERVAL_MS) {
        dht_sampled_at = now;
        motor_stop();
        timebase_pause();
        uint8_t code = dht11_read(&temperature, &humidity);
        timebase_resume();
        dht_status = code == 0 ? 1 : 2;
#if INTEGRATION_STAGE >= 6
        {
            dbg_t d;
            dbg_start(&d, code == 0 ? 'i' : 'w');
            if (code == 0) {
                dbg_p(&d, PSTR("DHT11 ok T="));
                dbg_u(&d, temperature);
                dbg_p(&d, PSTR("C H="));
                dbg_u(&d, humidity);
                dbg_p(&d, PSTR("%"));
            } else {
                dbg_p(&d, PSTR("DHT11 FAIL code="));
                dbg_u(&d, code);
                dbg_p(&d, code <= 3 ? PSTR(" (no response)") : code == 4 ? PSTR(" (bit timeout)")
                                                                          : PSTR(" (checksum)"));
            }
            dbg_send(&d);
        }
        sample_cycle_dht_done(code, temperature, humidity);
#endif
        return 1;
    }
#endif
    if (bh1750_service(now)) {
        if (bh1750_state() == BH1750_OFF) light_status = 2;
        return 1;
    }
    if (bh1750_state() == BH1750_OFF &&
        (uint32_t)(now - light_attempt) >= PERIPHERAL_RETRY_MS) {
        light_attempt = now;
        if (!bh1750_init()) {
            light_status = 2;
#if INTEGRATION_STAGE >= 6
            dbg_msg('w', PSTR("BH1750 init failed (I2C), retrying in 1 s"));
#endif
        }
        return 1;
    }
    if (bh1750_state() == BH1750_READY &&
#if INTEGRATION_STAGE >= 6
        sample_cycle_needs_light(now)) {
#else
        (uint32_t)(now - light_read) >= BH1750_INTERVAL_MS) {
        light_read = now;
#endif
        light_status = bh1750_read_lux(&lux) ? 1 : 2;
#if INTEGRATION_STAGE >= 6
        {
            dbg_t d;
            dbg_start(&d, light_status == 1 ? 'i' : 'w');
            if (light_status == 1) {
                dbg_p(&d, PSTR("BH1750 ok L="));
                dbg_u(&d, lux);
                dbg_p(&d, PSTR(" lx"));
            } else {
                dbg_p(&d, PSTR("BH1750 read FAIL (I2C)"));
            }
            dbg_send(&d);
        }
        sample_cycle_light_done(light_status == 1, lux);
#endif
        if (light_status == 2) light_attempt = timebase_millis();
        return 1;
    }
    return 0;
}
#endif

#if INTEGRATION_STAGE >= 2
static uint32_t displayed_at;
#if INTEGRATION_STAGE >= 3
static void set_metric(uint8_t row, const char *prefix, uint16_t value,
                       const char *suffix, uint8_t status)
{
    char text[OLED_COLUMNS + 1];
    strcpy(text, prefix);
    if (status == 1) utoa(value, text + strlen(text), 10);
    else strcat(text, status == 2 ? "ERR" : "---");
    strcat(text, suffix);
    oled_set_line(row, text);
}
#endif

static void update_display(uint32_t now)
{
    static uint8_t displayed_finished;
    uint8_t finished = line_follow_is_finished();
#if INTEGRATION_STAGE >= 6
    static sample_phase_t displayed_phase = SAMPLE_RESULT;
    sample_phase_t phase = sample_cycle_phase();
#endif
    if (
        displayed_finished != finished ||
#if INTEGRATION_STAGE >= 6
        displayed_phase != phase ||
#endif
        (uint32_t)(now - displayed_at) >= DISPLAY_INTERVAL_MS) {
        displayed_at = now;
        displayed_finished = finished;
        if (finished) {
            /* Laps finished takes priority over whatever the sample
             * cycle was showing -- the run is over, hold this screen. */
            oled_set_line(0, "Run complete");
            oled_set_line(1, "Laps finished");
            oled_set_line(2, "Car is stopped");
            oled_set_line(3, "");
        } else {
#if INTEGRATION_STAGE >= 6
        displayed_phase = phase;
        if (phase == SAMPLE_DRIVING) {
            oled_set_line(0, "Object detection");
            oled_set_line(1, sample_cycle_near_object() ? "Object sampled" : "No object");
            oled_set_line(2, motor_is_driving() ? "Car is moving" : "Car is stopped");
            oled_set_line(3, "");
        } else if (phase == SAMPLE_CLASSIFYING) {
            oled_set_line(0, "Object Detected");
            oled_set_line(1, "Classifying...");
            oled_set_line(2, "Please wait");
            oled_set_line(3, "Car is stopped");
        } else if (phase == SAMPLE_RESULT) {
            /* 21 columns per row. Row 1 shows SylvanAI's confidence when it was sent. */
            uint8_t verdict = sample_cycle_classification();
            uint8_t percent = sample_cycle_confidence();
            if (verdict == 'H' || verdict == 'S' || verdict == 'T' || verdict == 'O' ||
                verdict == 'U') {
                oled_set_line(0, verdict == 'H'   ? "Tree: healthy"
                                 : verdict == 'S' ? "Tree: unhealthy"
                                 : verdict == 'T' ? "Tree detected"
                                 : verdict == 'O' ? "Random Object"
                                                  : "Unclear photo");
                if (percent != UART_NO_CONFIDENCE) {
                    char text[OLED_COLUMNS + 1] = "Confidence ";
                    utoa(percent, text + strlen(text), 10);
                    strcat(text, "%");
                    oled_set_line(1, text);
                } else {
                    oled_set_line(1, verdict == 'O' ? "detected" : "");
                }
            } else {
                oled_set_line(0, "No result");
                oled_set_line(1, "Check WiFi/API");
            }
            oled_set_line(2, sample_cycle_succeeded() ? "Sensors OK" : "Sensor failed");
            oled_set_line(3, "Car is stopped");
        } else {
            uint8_t t_status = dht_status, l_status = light_status;
            if (phase == SAMPLE_READINGS) {
                if (!t_status) t_status = 2;
                if (!l_status) l_status = 2;
            }
            oled_set_line(0, "Object Detected");
            set_metric(1, "T:", temperature, "C", t_status);
            set_metric(2, "L:", lux, "LX", l_status);
            set_metric(3, "H:", humidity, "%", t_status);
        }
#else
#if INTEGRATION_STAGE >= 5
        set_metric(3, "D:", distance,
                   distance != HCSR04_INVALID_CM && distance <= OBSTACLE_DISTANCE_CM
                   ? "CM OBJECT" : "CM", distance_status);
#endif
#if INTEGRATION_STAGE >= 4
        set_metric(0, "T:", temperature, "C", dht_status);
        set_metric(1, "H:", humidity, "%", dht_status);
#endif
#if INTEGRATION_STAGE >= 3
        set_metric(2, "L:", lux, "LX", light_status);
#endif
#endif
        }
    }
    oled_service(now);
}
#endif

int main(void)
{
#if INTEGRATION_STAGE >= 6
    /* Read and clear the reset cause first, so the next reset reports only its own cause. */
    uint8_t reset_flags = MCUCSR;
    MCUCSR = 0;
#endif
    motor_init();
    line_sensor_init();
    timebase_init();
    line_follow_init(timebase_millis());
#if INTEGRATION_STAGE >= 6
    sample_cycle_init();
    uart_init();
#endif
#if INTEGRATION_STAGE >= 2
    twi_init();
    oled_init();
#if INTEGRATION_STAGE < 6
    oled_set_line(0, "T:---C");
    oled_set_line(1, "H:---%");
    oled_set_line(2, "L:---LX");
    oled_set_line(3, "D:---CM");
#endif
#endif
#if INTEGRATION_STAGE >= 3
    light_attempt = timebase_millis() - PERIPHERAL_RETRY_MS;
#endif
#if INTEGRATION_STAGE >= 4
    dht11_init();
    dht_sampled_at = timebase_millis();
#endif
#if INTEGRATION_STAGE >= 5
    hcsr04_init();
    ping_started = timebase_millis() - HCSR04_INTERVAL_MS;
#endif
#if INTEGRATION_STAGE >= 6
    log_boot(reset_flags);
#endif
    for (;;) {
        uint32_t now = timebase_millis();
#if INTEGRATION_STAGE >= 6
        sample_cycle_update(now);
        update_trail(now);
#endif
        line_follow_update(now);
#if INTEGRATION_STAGE >= 5
        if (update_distance(now)) continue;
#endif
#if INTEGRATION_STAGE >= 3
        if (update_environment(now)) continue;
#endif
#if INTEGRATION_STAGE >= 2
        update_display(now);
#endif
    }
}
