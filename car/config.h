
#ifndef CONFIG_H
#define CONFIG_H

#ifndef F_CPU
#define F_CPU 1000000UL
#endif


/* Fixed hardware allocation for the modular build. */
#if F_CPU != 1000000UL
#error "Project Sylvan timing requires F_CPU = 1000000UL"
#endif
#ifndef INTEGRATION_STAGE
#define INTEGRATION_STAGE 6
#endif
#if INTEGRATION_STAGE < 1 || INTEGRATION_STAGE > 6
#error "INTEGRATION_STAGE must be from 1 to 6"
#endif
#define MOTOR_IN1 PB0
#define MOTOR_IN2 PB1
#define MOTOR_IN3 PB2
#define MOTOR_IN4 PB3
#define MOTOR_ENA PD5
#define MOTOR_ENB PD4
#define MOTOR_PWM_TOP 49U
#define HCSR04_TRIG_PIN PA0
#define HCSR04_ECHO_PIN PA4
#define DHT11_PIN PA3
#define TWI_SCL_PIN PC0
#define TWI_SDA_PIN PC1
#define OLED_ADDR 0x3C
#define BH1750_ADDR 0x23
/* ESP32-CAM link: PD1/TXD only, 8N1, U2X. Use 4800 if the RC oscillator drifts. */
#define UART_BAUD 9600UL
#define OBSTACLE_DISTANCE_CM 10U
#define OBJECT_CLEAR_DISTANCE_CM 35U
#define OBJECT_CLEAR_TIME_MS 500UL
#define SAMPLE_ACQUIRE_TIMEOUT_MS 3000UL
#define SAMPLE_LIGHT_SETTLE_MS 200UL
#define SAMPLE_READINGS_TIME_MS 2000UL
#define SAMPLE_RESULT_TIME_MS 2000UL
/* Longest wait for the ESP32's tree/object verdict before showing "No result". */
#define CLASSIFY_TIMEOUT_MS 20000UL
#define HCSR04_INTERVAL_MS 80U
#define HCSR04_TIMEOUT_US 30000UL
#define DHT11_INTERVAL_MS 2000UL
#define BH1750_INTERVAL_MS 500UL
#define DISPLAY_INTERVAL_MS 200UL
#define PERIPHERAL_RETRY_MS 1000UL
#define TWI_TIMEOUT_MS 2U

// =====================================================
// SENSOR CONFIGURATION
// =====================================================

#define LEFT_SENSOR_PIN   PA1
#define RIGHT_SENSOR_PIN  PA2

/*
 * Current calibrated sensor behavior:
 *
 * BLACK TAPE   -> OUT HIGH
 * NORMAL FLOOR -> OUT LOW
 */
#define SENSOR_BLACK_IS_HIGH 1


// =====================================================
// SPEED SETTINGS
// =====================================================

/*
 * Normal speed on straight track.
 *
 * Increase -> faster but more overshoot.
 * Decrease -> easier to follow curves.
 */
#define BASE_SPEED_PERCENT       80U


/*
 * Speed while pivoting left/right.
 *
 * Pivoting spins both wheels in opposite directions, so each
 * wheel scrubs sideways against the ground instead of rolling.
 * That needs MORE torque than straight driving, not less, so
 * this should not be set below BASE_SPEED_PERCENT or the rover
 * can stall mid-turn.
 */
#define PIVOT_SPEED_PERCENT      100U


/*
 * Speed during the tiny reverse operation.
 */
#define REVERSE_SPEED_PERCENT    75U


// =====================================================
// RECOVERY TIMINGS
// =====================================================

/*
 * When BOTH sensors suddenly lose black:
 *
 * 1. Brake
 * 2. Reverse slightly
 * 3. Brake
 * 4. Pivot toward the last known line direction
 */


/*
 * Increase if the robot continues travelling
 * forward too much after losing the line.
 */
#define BRAKE_TIME_MS            25U


/*
 * How far the robot backs up.
 *
 * Increase -> backs farther.
 * Decrease -> smaller correction.
 */
#define REVERSE_TIME_MS          40U


/*
 * Small brake after reversing so reverse momentum
 * does not interfere with the pivot.
 */
#define REVERSE_BRAKE_TIME_MS    15U


/*
 * Maximum amount of time allowed to search for
 * the tape after losing it.
 *
 * Increase if it almost finds the line but stops.
 */
#define SEARCH_TIMEOUT_MS       300U


// =====================================================
// STARTUP
// =====================================================

#define START_DELAY_MS         1000U


// =====================================================
// LAP COUNTING (TIME-BASED)
// =====================================================

/*
 * There is no physical marker/crossing on the track, so laps are
 * counted by elapsed time instead of a detected event.
 *
 * Stopwatch how long ONE lap actually takes at this robot's normal
 * driving speed on this track, and put that value in LAP_DURATION_MS.
 * The robot then drives for LAPS_TO_RUN * LAP_DURATION_MS after it
 * starts moving and stops immediately wherever it happens to be --
 * it is not expected to stop back at the starting point.
 *
 * This drifts if lap time isn't consistent (e.g. obstacle stops from
 * the sample-cycle feature, or motor speed sagging as the battery
 * drains over a long run), so recalibrate after any speed change.
 */
#define LAP_DURATION_MS         8000UL  /* <-- measure your own lap and set this */
#define LAPS_TO_RUN             3U

/*
 * Switch for the lap limit above.
 *
 * 1 = normal: stop for good after LAPS_TO_RUN * LAP_DURATION_MS of driving.
 * 0 = debugging: never stop on its own -- runs the line-following loop
 *     forever (until power is cut or an obstacle/recovery state needs it).
 */
#define LAP_LIMIT_ENABLED       0


#endif
