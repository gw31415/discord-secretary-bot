# Builds MicroPython for the bot into $(BUILD)/libmicropython.a (and the
# generated headers). Run once by prewarm.sh, in the box:
#   make -C /lang/sdk/port TOP=<micropython> BUILD=<out> WASI_SDK=<wasi-sdk>
# build.sh then links the archive with each build's files.c.
include $(TOP)/py/mkenv.mk

QSTR_DEFS =
MICROPY_ROM_TEXT_COMPRESSION = 0

include $(TOP)/py/py.mk
include $(TOP)/extmod/extmod.mk

CC = $(WASI_SDK)/bin/clang
AR = $(WASI_SDK)/bin/llvm-ar
CPP = $(CC) -E

INC += -I. -I$(TOP) -I$(BUILD)
CFLAGS += $(INC) --target=wasm32-wasip1 -std=gnu99 -Wall -Wno-unused-command-line-argument \
	-Oz -DNDEBUG -fdata-sections -ffunction-sections -mllvm -wasm-enable-sjlj \
	-D_WASI_EMULATED_SIGNAL
CFLAGS += $(CFLAGS_EXTRA)
CSUPEROPT = -O2

SRC_C = main.c \
	shared/runtime/sys_stdio_mphal.c \
	shared/timeutils/timeutils.c

SRC_QSTR += main.c shared/runtime/sys_stdio_mphal.c shared/timeutils/timeutils.c

OBJ += $(PY_O)
OBJ += $(addprefix $(BUILD)/, $(SRC_C:.c=.o))

all: lib

include $(TOP)/py/mkrules.mk
