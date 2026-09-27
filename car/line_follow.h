#ifndef LINE_FOLLOW_H
#define LINE_FOLLOW_H
#include <stdint.h>
void line_follow_init(uint32_t now);
void line_follow_update(uint32_t now);
/* Hold motor output and freeze recovery/startup elapsed time until resumed. */
void line_follow_set_paused(uint8_t paused, uint32_t now);
/* True once the LAPS_TO_RUN time budget has elapsed and the robot has stopped for good. */
uint8_t line_follow_is_finished(void);
/* True while stopped waiting for either sensor to see the tape (search timed out). */
uint8_t line_follow_is_lost(void);
#endif
