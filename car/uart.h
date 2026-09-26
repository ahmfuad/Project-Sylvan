#ifndef UART_H
#define UART_H
#include <stdint.h>
/* USART, UART_BAUD 8N1 U2X: blocking transmit on PD1/TXD, interrupt-driven receive on PD0/RXD. */
void uart_init(void);
void uart_putc(char c);
void uart_puts(const char *s);
/* Sends "<S,T=<temp_c>,H=<humidity>,L=<lux>>\n" using integer formatting only. */
void uart_send_sample(int16_t temp_c, uint8_t humidity, uint16_t lux);
/* Sends "<F>\n". */
void uart_send_sample_failed(void);
/* Feeds one received byte to the "<C,x>" parser (called from the RX interrupt). */
void uart_rx_byte(char c);
/* Returns 'T', 'O' or 'E' once per received reply, else 0; clears it. */
uint8_t uart_take_classification(void);
#endif
