#include "config.h"
#include "line_follow.h"
#include "line_sensor.h"
#include "motor.h"

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



static uint8_t previousLeftBlack, previousRightBlack;
static uint8_t firstOffSensor, lastTurn;
static RobotState state;
static uint32_t stateStartTime;
static uint8_t starting, paused, finished;
static uint32_t pause_started;
static uint32_t runStartTime;

void line_follow_init(uint32_t now)
{
    firstOffSensor = SENSOR_NONE;
    lastTurn = TURN_NONE;
    state = STATE_STOP;
    starting = 1;
    paused = 0;
    finished = 0;
    stateStartTime = now;
    motor_stop();
}

void line_follow_set_paused(uint8_t hold, uint32_t now)
{
    if (hold) {
        if (!paused) pause_started = now;
        paused = 1;
        motor_stop();
    } else if (paused) {
        uint32_t elapsed = (uint32_t)(now - pause_started);
        stateStartTime += elapsed;
        runStartTime += elapsed;
        paused = 0;
    }
}

uint8_t line_follow_is_lost(void)
{
    return !starting && !paused && !finished && state == STATE_STOP;
}

uint8_t line_follow_is_finished(void)
{
    return finished;
}

void line_follow_update(uint32_t now)
{
    if (finished) { motor_stop(); return; }
    if (paused) { motor_stop(); return; }
    if (starting) {
        motor_stop();
        if ((uint32_t)(now - stateStartTime) < START_DELAY_MS) return;
        starting = 0;
        state = STATE_FOLLOW;
        runStartTime = now;
        previousLeftBlack = line_left_on_black();
        previousRightBlack = line_right_on_black();
    }

    /*
     * No physical lap marker exists on the track, so laps are counted
     * by elapsed driving time instead. Once the budget for LAPS_TO_RUN
     * laps runs out, stop immediately wherever the robot happens to be.
     */
#if LAP_LIMIT_ENABLED
    if (!starting &&
        (uint32_t)(now - runStartTime) >= (LAPS_TO_RUN * LAP_DURATION_MS))
    {
        finished = 1;
        motor_stop();
        return;
    }
#endif

    uint8_t leftBlack = line_left_on_black();
    uint8_t rightBlack = line_right_on_black();

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

            motor_forward();
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

                motor_pivot_left();
            }
            else
            {
                lastTurn = TURN_RIGHT;

                motor_pivot_right();
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

                motor_pivot_right();
            }
            else
            {
                lastTurn = TURN_LEFT;

                motor_pivot_left();
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
            motor_brake();

            state = STATE_BRAKE;

            stateStartTime = now;
        }
    }


    // =================================================
    // BRAKING
    // =================================================

    else if (state == STATE_BRAKE)
    {
        motor_brake();


        if (
            (uint32_t)(now - stateStartTime)
            >= BRAKE_TIME_MS
        )
        {
            motor_backward();

            state = STATE_REVERSE;

            stateStartTime = now;
        }
    }


    // =================================================
    // SMALL REVERSE
    // =================================================

    else if (state == STATE_REVERSE)
    {
        motor_backward();


        if (
            (uint32_t)(now - stateStartTime)
            >= REVERSE_TIME_MS
        )
        {
            motor_brake();

            state = STATE_REVERSE_BRAKE;

            stateStartTime = now;
        }
    }


    // =================================================
    // BRAKE AFTER REVERSE
    // =================================================

    else if (state == STATE_REVERSE_BRAKE)
    {
        motor_brake();


        if (
            (uint32_t)(now - stateStartTime)
            >= REVERSE_BRAKE_TIME_MS
        )
        {
            if (lastTurn == TURN_LEFT)
            {
                motor_pivot_left();

                state = STATE_SEARCH_LEFT;
            }

            else if (lastTurn == TURN_RIGHT)
            {
                motor_pivot_right();

                state = STATE_SEARCH_RIGHT;
            }

            else
            {
                motor_stop();

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

            return;
        }


        motor_pivot_left();


        if (
            (uint32_t)(now - stateStartTime)
            >= SEARCH_TIMEOUT_MS
        )
        {
            motor_stop();

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

            return;
        }


        motor_pivot_right();


        if (
            (uint32_t)(now - stateStartTime)
            >= SEARCH_TIMEOUT_MS
        )
        {
            motor_stop();

            state = STATE_STOP;
        }
    }


    // =================================================
    // STOPPED / WAITING FOR THE LINE
    // =================================================

    else if (state == STATE_STOP)
    {
        motor_stop();

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
        motor_stop();
        state = STATE_STOP;
    }


    /* Save this sample so the next loop can detect an off edge. */
    previousLeftBlack = leftBlack;
    previousRightBlack = rightBlack;
}
