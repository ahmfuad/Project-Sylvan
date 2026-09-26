#include "config.h"
#include "timebase.h"

#include <avr/io.h>
#include <avr/interrupt.h>
#include <stdint.h>


// =====================================================
// MOTOR CONFIGURATION
// =====================================================
//
// PB0 -> IN1 -> LEFT forward
// PB1 -> IN2 -> LEFT backward
// PB2 -> IN3 -> RIGHT forward
// PB3 -> IN4 -> RIGHT backward
//
// PD5 / OC1A -> ENA -> LEFT speed
// PD4 / OC1B -> ENB -> RIGHT speed
//

#define MOTOR_MASK 0x0FU

#define PWM_TOP 49U


// =====================================================
// MOTOR DIRECTION PATTERNS
// =====================================================
//
// PB3 PB2 PB1 PB0
//
// 0101 = both forward
// 1010 = both backward
//
// 0110 = left backward, right forward
//        -> pivot LEFT
//
// 1001 = left forward, right backward
//        -> pivot RIGHT
//
// 1111 = dynamic brake
//

#define MOTOR_FORWARD   0x05U
#define MOTOR_BACKWARD  0x0AU
#define MOTOR_LEFT      0x06U
#define MOTOR_RIGHT     0x09U
#define MOTOR_BRAKE     0x0FU


// =====================================================
// TIMER0 SYSTEM CLOCK
// =====================================================
//
// Timer0 setup, the millisecond counter, and its ISR
// live in timebase.c (shared with twi.c/oled.c/bh1750.c).
// Use timebase_init()/timebase_millis() here instead of
// duplicating them, since only one ISR(TIMER0_COMP_vect)
// may exist across the whole link.

#define millis() timebase_millis()


// =====================================================
// TIMER1 PWM
// =====================================================

uint16_t percentToPWM(uint8_t percent)
{
    if (percent >= 100U)
    {
        return PWM_TOP;
    }

    return (uint16_t)(((uint32_t)percent * PWM_TOP) / 100U);
}


void pwmInit(void)
{
    /*
     * PD5 = OC1A = ENA
     * PD4 = OC1B = ENB
     */

    DDRD |=
          (1 << PD5)
        | (1 << PD4);


    /*
     * Timer1 Fast PWM Mode 14
     *
     * TOP = ICR1
     *
     * PWM frequency:
     *
     * 1 MHz / 50
     * = 20 kHz
     */

    TCCR1A =
          (1 << COM1A1)
        | (1 << COM1B1)
        | (1 << WGM11);


    TCCR1B =
          (1 << WGM13)
        | (1 << WGM12)
        | (1 << CS10);


    ICR1 = PWM_TOP;

    OCR1A = 0;
    OCR1B = 0;
}


void setSpeed(
    uint8_t leftPercent,
    uint8_t rightPercent
)
{
    OCR1A = percentToPWM(leftPercent);
    OCR1B = percentToPWM(rightPercent);
}


// =====================================================
// MOTOR COMMAND
// =====================================================

void setMotorPattern(uint8_t pattern)
{
    PORTB =
        (PORTB & (uint8_t)~MOTOR_MASK)
        | pattern;
}


// =====================================================
// MOVEMENT FUNCTIONS
// =====================================================

void moveForward(void)
{
    setMotorPattern(MOTOR_FORWARD);

    setSpeed(
        BASE_SPEED_PERCENT,
        BASE_SPEED_PERCENT
    );
}


void moveBackward(void)
{
    setMotorPattern(MOTOR_BACKWARD);

    setSpeed(
        REVERSE_SPEED_PERCENT,
        REVERSE_SPEED_PERCENT
    );
}


void pivotLeft(void)
{
    /*
     * LEFT motor backward
     * RIGHT motor forward
     */

    setMotorPattern(MOTOR_LEFT);

    setSpeed(
        PIVOT_SPEED_PERCENT,
        PIVOT_SPEED_PERCENT
    );
}


void pivotRight(void)
{
    /*
     * LEFT motor forward
     * RIGHT motor backward
     */

    setMotorPattern(MOTOR_RIGHT);

    setSpeed(
        PIVOT_SPEED_PERCENT,
        PIVOT_SPEED_PERCENT
    );
}


void brakeMotors(void)
{
    /*
     * L298N dynamic braking:
     *
     * IN1 = IN2 = HIGH
     * IN3 = IN4 = HIGH
     *
     * This attempts to stop the wheels much faster
     * than simply setting PWM to zero.
     */

    setMotorPattern(MOTOR_BRAKE);

    setSpeed(100, 100);
}


void stopMotors(void)
{
    setSpeed(0, 0);

    setMotorPattern(0x00);
}


// =====================================================
// SENSOR FUNCTIONS
// =====================================================

uint8_t sensorOnBlack(uint8_t pin)
{
    uint8_t high =
        (PINA & (1U << pin)) != 0U;


#if SENSOR_BLACK_IS_HIGH

    return high;

#else

    return !high;

#endif
}


// =====================================================
// CONTROL STATES
// =====================================================

typedef enum
{
    STATE_FOLLOW,

    STATE_BRAKE,

    STATE_REVERSE,

    STATE_REVERSE_BRAKE,

    STATE_SEARCH_LEFT,

    STATE_SEARCH_RIGHT,

    STATE_STOP

} RobotState;


#define TURN_NONE   0U
#define TURN_LEFT   1U
#define TURN_RIGHT  2U

#define SENSOR_NONE  0U
#define SENSOR_LEFT  1U
#define SENSOR_RIGHT 2U


// =====================================================
// MAIN
// =====================================================

int main(void)
{
    uint8_t leftBlack;
    uint8_t rightBlack;

    uint8_t previousLeftBlack;
    uint8_t previousRightBlack;

    /*
     * Remember which sensor left the black tape first.
     * The robot turns toward the opposite side.
     */
    uint8_t firstOffSensor = SENSOR_NONE;

    uint8_t lastTurn = TURN_NONE;


    RobotState state = STATE_STOP;


    uint32_t stateStartTime;
    uint32_t now;


    // =================================================
    // MOTOR DIRECTION PINS
    // =================================================

    DDRB |= MOTOR_MASK;


    // =================================================
    // SENSOR INPUTS
    // =================================================

    DDRA &= (uint8_t)~(
          (1U << LEFT_SENSOR_PIN)
        | (1U << RIGHT_SENSOR_PIN)
    );


    // Enable pull-ups
    PORTA |=
          (1U << LEFT_SENSOR_PIN)
        | (1U << RIGHT_SENSOR_PIN);


    // =================================================
    // INITIALIZE HARDWARE TIMERS
    // =================================================

    pwmInit();

    timebase_init();


    // Enable interrupts globally
    sei();


    stopMotors();


    // =================================================
    // STARTUP DELAY USING TIMER0
    // =================================================

    stateStartTime = millis();

    while (
        (uint32_t)(millis() - stateStartTime)
        < START_DELAY_MS
    )
    {
        stopMotors();
    }


    state = STATE_FOLLOW;

    previousLeftBlack =
        sensorOnBlack(LEFT_SENSOR_PIN);

    previousRightBlack =
        sensorOnBlack(RIGHT_SENSOR_PIN);


    // =================================================
    // MAIN CONTROL LOOP
    // =================================================

    while (1)
    {
        now = millis();


        // -------------------------------------------------
        // Read sensors continuously.
        //
        // This happens even during braking/recovery.
        // -------------------------------------------------

        leftBlack =
            sensorOnBlack(LEFT_SENSOR_PIN);

        rightBlack =
            sensorOnBlack(RIGHT_SENSOR_PIN);


        // =================================================
        // NORMAL LINE FOLLOWING
        // =================================================

        if (state == STATE_FOLLOW)
        {
            uint8_t leftWentOff =
                previousLeftBlack && !leftBlack;

            uint8_t rightWentOff =
                previousRightBlack && !rightBlack;

            /*
             * Latch only the first unambiguous BLACK-to-FLOOR edge.
             * If both edges occur in one sample, retain the older turn.
             */
            if (firstOffSensor == SENSOR_NONE)
            {
                if (leftWentOff && !rightWentOff)
                {
                    firstOffSensor = SENSOR_LEFT;
                }
                else if (rightWentOff && !leftWentOff)
                {
                    firstOffSensor = SENSOR_RIGHT;
                }
            }

            /* Always turn opposite to the sensor that went off first. */
            if (firstOffSensor == SENSOR_LEFT)
            {
                lastTurn = TURN_RIGHT;
            }
            else if (firstOffSensor == SENSOR_RIGHT)
            {
                lastTurn = TURN_LEFT;
            }

            // ---------------------------------------------
            // BLACK + BLACK
            // ---------------------------------------------

            if (leftBlack && rightBlack)
            {
                /* A centered line starts a new detection cycle. */
                firstOffSensor = SENSOR_NONE;

                moveForward();
            }


            // ---------------------------------------------
            // BLACK + FLOOR: right sensor went off first,
            // so turn in the opposite direction (LEFT).
            // ---------------------------------------------

            else if (leftBlack && !rightBlack)
            {
                if (firstOffSensor == SENSOR_NONE)
                {
                    /* Fallback if the program started off the line. */
                    firstOffSensor = SENSOR_RIGHT;
                    lastTurn = TURN_LEFT;
                }

                if (firstOffSensor == SENSOR_RIGHT)
                {
                    lastTurn = TURN_LEFT;

                    pivotLeft();
                }
                else
                {
                    lastTurn = TURN_RIGHT;

                    pivotRight();
                }
            }


            // ---------------------------------------------
            // FLOOR + BLACK: left sensor went off first,
            // so turn in the opposite direction (RIGHT).
            // ---------------------------------------------

            else if (!leftBlack && rightBlack)
            {
                if (firstOffSensor == SENSOR_NONE)
                {
                    /* Fallback if the program started off the line. */
                    firstOffSensor = SENSOR_LEFT;
                    lastTurn = TURN_RIGHT;
                }

                if (firstOffSensor == SENSOR_LEFT)
                {
                    lastTurn = TURN_RIGHT;

                    pivotRight();
                }
                else
                {
                    lastTurn = TURN_LEFT;

                    pivotLeft();
                }
            }


            // ---------------------------------------------
            // FLOOR + FLOOR
            //
            // Both sensors lost tape.
            //
            // Immediately start recovery.
            // ---------------------------------------------

            else
            {
                brakeMotors();

                state = STATE_BRAKE;

                stateStartTime = now;
            }
        }


        // =================================================
        // BRAKING
        // =================================================

        else if (state == STATE_BRAKE)
        {
            brakeMotors();


            if (
                (uint32_t)(now - stateStartTime)
                >= BRAKE_TIME_MS
            )
            {
                moveBackward();

                state = STATE_REVERSE;

                stateStartTime = now;
            }
        }


        // =================================================
        // SMALL REVERSE
        // =================================================

        else if (state == STATE_REVERSE)
        {
            moveBackward();


            if (
                (uint32_t)(now - stateStartTime)
                >= REVERSE_TIME_MS
            )
            {
                brakeMotors();

                state = STATE_REVERSE_BRAKE;

                stateStartTime = now;
            }
        }


        // =================================================
        // BRAKE AFTER REVERSE
        // =================================================

        else if (state == STATE_REVERSE_BRAKE)
        {
            brakeMotors();


            if (
                (uint32_t)(now - stateStartTime)
                >= REVERSE_BRAKE_TIME_MS
            )
            {
                if (lastTurn == TURN_LEFT)
                {
                    pivotLeft();

                    state = STATE_SEARCH_LEFT;
                }

                else if (lastTurn == TURN_RIGHT)
                {
                    pivotRight();

                    state = STATE_SEARCH_RIGHT;
                }

                else
                {
                    stopMotors();

                    state = STATE_STOP;
                }


                stateStartTime = now;
            }
        }


        // =================================================
        // SEARCH LEFT
        // =================================================

        else if (state == STATE_SEARCH_LEFT)
        {
            /*
             * VERY IMPORTANT:
             *
             * We are still reading both sensors during
             * the search.
             *
             * As soon as EITHER sensor finds black,
             * recovery immediately ends.
             */

            if (leftBlack || rightBlack)
            {
                state = STATE_FOLLOW;

                previousLeftBlack = leftBlack;
                previousRightBlack = rightBlack;

                continue;
            }


            pivotLeft();


            if (
                (uint32_t)(now - stateStartTime)
                >= SEARCH_TIMEOUT_MS
            )
            {
                stopMotors();

                state = STATE_STOP;
            }
        }


        // =================================================
        // SEARCH RIGHT
        // =================================================

        else if (state == STATE_SEARCH_RIGHT)
        {
            if (leftBlack || rightBlack)
            {
                state = STATE_FOLLOW;

                previousLeftBlack = leftBlack;
                previousRightBlack = rightBlack;

                continue;
            }


            pivotRight();


            if (
                (uint32_t)(now - stateStartTime)
                >= SEARCH_TIMEOUT_MS
            )
            {
                stopMotors();

                state = STATE_STOP;
            }
        }


        // =================================================
        // STOPPED / WAITING FOR THE LINE
        // =================================================

        else if (state == STATE_STOP)
        {
            stopMotors();

            /*
             * A stop is recoverable.  This is especially important at
             * startup, when both sensors may initially be off the tape and
             * lastTurn is not known yet.  Keep the motors safely disabled,
             * but resume line following as soon as either sensor sees black.
             */
            if (leftBlack || rightBlack)
            {
                firstOffSensor = SENSOR_NONE;
                state = STATE_FOLLOW;
            }
        }


        // Defensive fallback for an invalid state value.
        else
        {
            stopMotors();
            state = STATE_STOP;
        }


        /* Save this sample so the next loop can detect an off edge. */
        previousLeftBlack = leftBlack;
        previousRightBlack = rightBlack;
    }
}
