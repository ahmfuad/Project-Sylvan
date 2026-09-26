#include "config.h"
#include "uart.h"
#include <avr/io.h>
#include <avr/interrupt.h>

/* Double-speed mode: baud = F_CPU / (8 * (UBRR + 1)), rounded to nearest. */
#define UART_UBRR ((F_CPU + 4UL * UART_BAUD) / (8UL * UART_BAUD) - 1UL)
#define UART_ACTUAL_BAUD (F_CPU / (8UL * (UART_UBRR + 1UL)))
#if UART_UBRR > 4095UL
#error "UART_BAUD is too low for F_CPU"
#endif
#if (UART_ACTUAL_BAUD > UART_BAUD ? UART_ACTUAL_BAUD - UART_BAUD : \
     UART_BAUD - UART_ACTUAL_BAUD) * 1000UL > UART_BAUD * 20UL
#error "UART_BAUD has more than 2% error at F_CPU with U2X"
#endif

void uart_init(void)
{
    /* UBRRH shares its address with UCSRC; URSEL clear selects UBRRH. */
    UBRRH = (uint8_t)(UART_UBRR >> 8);
    UBRRL = (uint8_t)UART_UBRR;
    UCSRA = (1 << U2X);
    UCSRC = (1 << URSEL) | (1 << UCSZ1) | (1 << UCSZ0);
    UCSRB = (1 << TXEN) | (1 << RXEN) | (1 << RXCIE);
}

/* Receiver for the ESP32's "<C,x>\n" reply; x is T (tree), O (object) or E (error). */
static volatile uint8_t classification;
static uint8_t rx_pos;
static char rx_code;

void uart_rx_byte(char c)
{
    if (c == '<') { rx_pos = 1; return; }
    switch (rx_pos) {
    case 1: rx_pos = c == 'C' ? 2 : 0; break;
    case 2: rx_pos = c == ',' ? 3 : 0; break;
    case 3:
        rx_code = c;
        rx_pos = (c == 'T' || c == 'O' || c == 'E') ? 4 : 0;
        break;
    case 4:
        if (c == '>') classification = (uint8_t)rx_code;
        rx_pos = 0;
        break;
    default: break;
    }
}

ISR(USART_RXC_vect)
{
    uart_rx_byte((char)UDR);
}

uint8_t uart_take_classification(void)
{
    uint8_t saved = SREG;
    cli();
    uint8_t value = classification;
    classification = 0;
    SREG = saved;
    return value;
}

void uart_putc(char c)
{
    loop_until_bit_is_set(UCSRA, UDRE);
    UDR = (uint8_t)c;
}

void uart_puts(const char *s)
{
    while (*s) uart_putc(*s++);
}

static void put_uint(uint16_t value)
{
    char digits[5];
    uint8_t count = 0;
    do {
        digits[count++] = (char)('0' + value % 10U);
        value /= 10U;
    } while (value);
    while (count) uart_putc(digits[--count]);
}

void uart_send_sample(int16_t temp_c, uint8_t humidity, uint16_t lux)
{
    uart_puts("<S,T=");
    if (temp_c < 0) {
        uart_putc('-');
        put_uint((uint16_t)(0U - (uint16_t)temp_c));
    } else {
        put_uint((uint16_t)temp_c);
    }
    uart_puts(",H=");
    put_uint(humidity);
    uart_puts(",L=");
    put_uint(lux);
    uart_puts(">\n");
}

void uart_send_sample_failed(void)
{
    uart_puts("<F>\n");
}
