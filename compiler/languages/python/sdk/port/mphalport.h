#include <stdint.h>
#include <time.h>

mp_uint_t mp_hal_stdout_tx_strn(const char *str, size_t len);
static inline int mp_hal_stdin_rx_chr(void) { return -1; }
static inline void mp_hal_set_interrupt_char(char c) { (void)c; }

static inline uint64_t secretary_now_ns(clockid_t clock) {
    struct timespec ts;
    clock_gettime(clock, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}
static inline mp_uint_t mp_hal_ticks_ms(void) { return (mp_uint_t)(secretary_now_ns(CLOCK_MONOTONIC) / 1000000); }
static inline mp_uint_t mp_hal_ticks_us(void) { return (mp_uint_t)(secretary_now_ns(CLOCK_MONOTONIC) / 1000); }
static inline mp_uint_t mp_hal_ticks_cpu(void) { return (mp_uint_t)secretary_now_ns(CLOCK_MONOTONIC); }
static inline uint64_t mp_hal_time_ns(void) { return secretary_now_ns(CLOCK_REALTIME); }
void mp_hal_delay_ms(mp_uint_t ms);
void mp_hal_delay_us(mp_uint_t us);
