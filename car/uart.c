#include "config.h"
#include "uart.h"
#include <avr/io.h>
#include <avr/interrupt.h>
#include <avr/pgmspace.h>

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

/* Power of two so the index wraps with a mask. 128 bytes is ~130 ms of output at 9600 baud. */
#define TX_SIZE 128U
#define TX_MASK (TX_SIZE - 1U)
static volatile char tx_buf[TX_SIZE];
static volatile uint8_t tx_head, tx_tail;
static uint16_t dropped;

void uart_init(void)
{
    /* UBRRH shares its address with UCSRC; URSEL clear selects UBRRH. */
    UBRRH = (uint8_t)(UART_UBRR >> 8);
    UBRRL = (uint8_t)UART_UBRR;
    UCSRA = (1 << U2X);
    UCSRC = (1 << URSEL) | (1 << UCSZ1) | (1 << UCSZ0);
    UCSRB = (1 << TXEN) | (1 << RXEN) | (1 << RXCIE);
}

ISR(USART_UDRE_vect)
{
    if (tx_head == tx_tail) {
        UCSRB &= (uint8_t)~(1 << UDRIE);
        return;
    }
    UDR = (uint8_t)tx_buf[tx_tail];
    tx_tail = (uint8_t)((tx_tail + 1U) & TX_MASK);
}

static uint8_t tx_free(void)
{
    uint8_t saved = SREG;
    cli();
    uint8_t used = (uint8_t)((tx_head - tx_tail) & TX_MASK);
    SREG = saved;
    return (uint8_t)(TX_SIZE - 1U - used);
}

void uart_putc(char c)
{
    uint8_t next = (uint8_t)((tx_head + 1U) & TX_MASK);
    while (next == tx_tail) {
        /* Full: the UDRE interrupt drains it (interrupts must be enabled). */
    }
    tx_buf[tx_head] = c;
    tx_head = next;
    UCSRB |= (1 << UDRIE);
}

void uart_puts(const char *s)
{
    while (*s) uart_putc(*s++);
}

static void uart_puts_p(const char *s)
{
    char c;
    while ((c = (char)pgm_read_byte(s++))) uart_putc(c);
}

/* Receiver for the ESP32's "<C,x>\n" or "<C,x,nn>\n" reply; x is H (healthy tree), S (unhealthy
 * tree), T (tree, health not visible), O (object), U (unclear), E (error); nn is the confidence. */
static volatile uint8_t classification, classification_confidence;
static uint8_t rx_pos, rx_digits;
static char rx_code;
static uint16_t rx_confidence;

void uart_rx_byte(char c)
{
    if (c == '<') { rx_pos = 1; return; }
    switch (rx_pos) {
    case 1: rx_pos = c == 'C' ? 2 : 0; break;
    case 2: rx_pos = c == ',' ? 3 : 0; break;
    case 3:
        rx_code = c;
        rx_pos = (c == 'T' || c == 'H' || c == 'S' || c == 'O' || c == 'U' || c == 'E') ? 4 : 0;
        break;
    case 4:
        if (c == '>') {
            classification = (uint8_t)rx_code;
            classification_confidence = UART_NO_CONFIDENCE;
            rx_pos = 0;
        } else if (c == ',') {
            rx_confidence = 0;
            rx_digits = 0;
            rx_pos = 5;
        } else {
            rx_pos = 0;
        }
        break;
    case 5:
        if (c >= '0' && c <= '9' && rx_digits < 3) {
            rx_confidence = (uint16_t)(rx_confidence * 10U + (uint16_t)(c - '0'));
            rx_digits++;
        } else {
            if (c == '>' && rx_digits > 0) {
                classification = (uint8_t)rx_code;
                classification_confidence =
                    rx_confidence > 100U ? UART_NO_CONFIDENCE : (uint8_t)rx_confidence;
            }
            rx_pos = 0;
        }
        break;
    default: break;
    }
}

ISR(USART_RXC_vect)
{
    uart_rx_byte((char)UDR);
}

uint8_t uart_take_classification(uint8_t *confidence)
{
    uint8_t saved = SREG;
    cli();
    uint8_t value = classification;
    if (confidence) *confidence = classification_confidence;
    classification = 0;
    SREG = saved;
    return value;
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
    uart_puts_p(PSTR("<S,T="));
    if (temp_c < 0) {
        uart_putc('-');
        put_uint((uint16_t)(0U - (uint16_t)temp_c));
    } else {
        put_uint((uint16_t)temp_c);
    }
    uart_puts_p(PSTR(",H="));
    put_uint(humidity);
    uart_puts_p(PSTR(",L="));
    put_uint(lux);
    uart_puts_p(PSTR(">\n"));
}

void uart_send_sample_failed(uint8_t dht_code, uint8_t lux_code)
{
    uart_puts_p(PSTR("<F,dht="));
    if (dht_code == 0) uart_puts_p(PSTR("ok"));
    else if (dht_code == 0xFF) uart_puts_p(PSTR("skip"));
    else put_uint(dht_code);
    uart_puts_p(PSTR(",lux="));
    uart_puts_p(lux_code == 0 ? PSTR("ok") : lux_code == 0xFF ? PSTR("skip") : PSTR("fail"));
    uart_puts_p(PSTR(">\n"));
}

/* ---- Debug trail --------------------------------------------------------------------------- */

static void dbg_c(dbg_t *d, char c)
{
    /* Keep room for the closing ">\n"; '<', '>' and newlines would break framing. */
    if (d->len >= DBG_LINE_MAX - 2U) return;
    if (c == '<' || c == '>' || c == '\n' || c == '\r') c = '_';
    d->buf[d->len++] = c;
}

void dbg_start(dbg_t *d, char level)
{
    d->len = 0;
    d->buf[d->len++] = '<';
    d->buf[d->len++] = 'D';
    d->buf[d->len++] = ',';
    d->buf[d->len++] = level;
    d->buf[d->len++] = ',';
}

void dbg_p(dbg_t *d, const char *progmem_text)
{
    char c;
    while ((c = (char)pgm_read_byte(progmem_text++))) dbg_c(d, c);
}

void dbg_s(dbg_t *d, const char *text)
{
    while (*text) dbg_c(d, *text++);
}

void dbg_u(dbg_t *d, uint16_t value)
{
    char digits[5];
    uint8_t count = 0;
    do {
        digits[count++] = (char)('0' + value % 10U);
        value /= 10U;
    } while (value);
    while (count) dbg_c(d, digits[--count]);
}

void dbg_send(dbg_t *d)
{
    d->buf[d->len++] = '>';
    d->buf[d->len++] = '\n';
    /* All or nothing: never block the control loop for a log line. */
    if (tx_free() < d->len) {
        dropped++;
        return;
    }
    for (uint8_t i = 0; i < d->len; i++) uart_putc(d->buf[i]);
}

void dbg_msg(char level, const char *progmem_text)
{
    dbg_t d;
    dbg_start(&d, level);
    dbg_p(&d, progmem_text);
    dbg_send(&d);
}

uint16_t dbg_dropped(void)
{
    return dropped;
}
