#ifndef TWI_H
#define TWI_H
#include <stdint.h>
void twi_init(void);
uint8_t twi_start(uint8_t address);
uint8_t twi_write(uint8_t data);
uint8_t twi_read_ack(uint8_t *data);
uint8_t twi_read_nack(uint8_t *data);
uint8_t twi_stop(void);
/* Failed I2C transactions since boot, for the debug trail heartbeat. */
uint16_t twi_error_count(void);
#endif
