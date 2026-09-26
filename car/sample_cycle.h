#ifndef SAMPLE_CYCLE_H
#define SAMPLE_CYCLE_H
#include <stdint.h>
typedef enum { SAMPLE_DRIVING, SAMPLE_ACQUIRING, SAMPLE_READINGS,
               SAMPLE_CLASSIFYING, SAMPLE_RESULT } sample_phase_t;
void sample_cycle_init(void);
/* Returns 1 only when a new object starts a sampling stop. */
uint8_t sample_cycle_observe(uint16_t distance_cm, uint32_t now);
void sample_cycle_update(uint32_t now);
sample_phase_t sample_cycle_phase(void);
uint8_t sample_cycle_near_object(void);
uint8_t sample_cycle_needs_dht(void);
uint8_t sample_cycle_needs_light(uint32_t now);
/* Readings are kept for the UART packet sent once when the result is known. */
void sample_cycle_dht_done(uint8_t success, int16_t temp_c, uint8_t humidity);
void sample_cycle_light_done(uint8_t success, uint16_t lux);
uint8_t sample_cycle_succeeded(void);
/* ESP32 photo verdict for the current stop: 'T' tree, 'O' object, 'E' error, 0 none/timeout. */
uint8_t sample_cycle_classification(void);
#endif
