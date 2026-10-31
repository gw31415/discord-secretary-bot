// Included by extmod/modtime.c (MICROPY_PY_TIME_INCLUDEFILE): the wall clock is
// WASI's realtime clock, in UTC.

#include "shared/timeutils/timeutils.h"

static void mp_time_localtime_get(timeutils_struct_time_t *tm) {
    timeutils_seconds_since_epoch_to_struct_time((mp_timestamp_t)(mp_hal_time_ns() / 1000000000ull), tm);
}

static mp_obj_t mp_time_time_get(void) {
    return mp_obj_new_float((mp_float_t)mp_hal_time_ns() / 1e9);
}
