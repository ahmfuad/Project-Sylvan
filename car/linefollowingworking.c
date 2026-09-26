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
        sample_cycle_needs_dht() &&
#endif
        (uint32_t)(now - dht_sampled_at) >= DHT11_INTERVAL_MS) {
        dht_sampled_at = now;
        motor_stop();
        timebase_pause();
        dht_status = dht11_read(&temperature, &humidity) == 0 ? 1 : 2;
        timebase_resume();
#if INTEGRATION_STAGE >= 6
        sample_cycle_dht_done(dht_status == 1, temperature, humidity);
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
        if (!bh1750_init()) light_status = 2;
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
#if INTEGRATION_STAGE >= 6
    static sample_phase_t displayed_phase = SAMPLE_RESULT;
    sample_phase_t phase = sample_cycle_phase();
#endif
    if (
#if INTEGRATION_STAGE >= 6
        displayed_phase != phase ||
#endif
        (uint32_t)(now - displayed_at) >= DISPLAY_INTERVAL_MS) {
        displayed_at = now;
#if INTEGRATION_STAGE >= 6
        displayed_phase = phase;
        if (phase == SAMPLE_DRIVING) {
            oled_set_line(0, "Object detection");
            oled_set_line(1, sample_cycle_near_object() ? "Object sampled" : "No object");
            oled_set_line(2, motor_is_driving() ? "Car is moving" : "Car is stopped");
            oled_set_line(3, "");
        } else if (phase == SAMPLE_RESULT) {
            oled_set_line(0, sample_cycle_succeeded() ? "Sample detected" : "Sample failed");
            oled_set_line(1, sample_cycle_succeeded() ? "successfully" : "Check sensors");
            oled_set_line(2, "Car is stopped");
            oled_set_line(3, "");
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
    oled_service(now);
}
#endif

int main(void)
{
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
    for (;;) {
        uint32_t now = timebase_millis();
#if INTEGRATION_STAGE >= 6
        sample_cycle_update(now);
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
