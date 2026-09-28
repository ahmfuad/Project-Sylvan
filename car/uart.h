#ifndef UART_H
#define UART_H
#include <stdint.h>
/*
 * USART, UART_BAUD 8N1 U2X. Transmit is interrupt-driven from a ring buffer, so logging never
 * stalls line following; receive is interrupt-driven into the "<C,x>" parser.
 *
 * Packets to the ESP32 (one per line):
 *   <S,T=30,H=66,L=235>        sample readings
 *   <F,dht=4,lux=ok>           failed sample and why (dht: ok|1..5|skip, lux: ok|fail|skip)
 *   <D,i,text>                 debug trail line; level i(nfo) w(arn) e(rror) d(ebug)
 * Replies from the ESP32:
 *   <C,H,97>                   verdict and confidence %: H healthy tree, S unhealthy tree,
 *                              T tree (health not visible), O object, U unclear, E error
 *   <C,T>                      the same without a confidence (older ESP32 firmware)
 */
void uart_init(void);
/* Blocks while the transmit buffer is full. Call with interrupts enabled. */
void uart_putc(char c);
void uart_puts(const char *s);
void uart_send_sample(int16_t temp_c, uint8_t humidity, uint16_t lux);
/* dht_code: 0 ok, 1..5 DHT11 error, 0xFF not read; lux_code: 0 ok, 1 read failed, 0xFF not read. */
void uart_send_sample_failed(uint8_t dht_code, uint8_t lux_code);
/* Feeds one received byte to the "<C,x[,nn]>" parser (called from the RX interrupt). */
void uart_rx_byte(char c);
/* Returns 'H', 'S', 'T', 'O', 'U' or 'E' once per received reply, else 0; clears it. `confidence` gets
 * 0-100, or UART_NO_CONFIDENCE when the reply carried none. */
#define UART_NO_CONFIDENCE 0xFFU
uint8_t uart_take_classification(uint8_t *confidence);

/*
 * Debug trail. Build a line, then send it; a line that does not fit in the transmit buffer is
 * dropped whole (counted by dbg_dropped()) so a packet is never cut in half.
 *   dbg_t d; dbg_start(&d, 'i'); dbg_p(&d, PSTR("dht ok T=")); dbg_u(&d, t); dbg_send(&d);
 */
#define DBG_LINE_MAX 56U
typedef struct {
    char buf[DBG_LINE_MAX];
    uint8_t len;
} dbg_t;
void dbg_start(dbg_t *d, char level);
void dbg_p(dbg_t *d, const char *progmem_text);
void dbg_s(dbg_t *d, const char *text);
void dbg_u(dbg_t *d, uint16_t value);
void dbg_send(dbg_t *d);
/* One-call form for a fixed PROGMEM message. */
void dbg_msg(char level, const char *progmem_text);
uint16_t dbg_dropped(void);
#endif
