CFLAGS ?= -O2 -Wall -Wextra
omabox-held: held.c ../keyboard/keyboard.c ../pointer/pointer.c ../common/agent-endpoint.h ../common/roundtrip.h
	$(MAKE) -C ../keyboard virtual-keyboard-unstable-v1-client-protocol.h virtual-keyboard-unstable-v1-protocol.c
	$(MAKE) -C ../pointer wlr-virtual-pointer-unstable-v1-client-protocol.h wlr-virtual-pointer-unstable-v1-protocol.c
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ held.c ../keyboard/virtual-keyboard-unstable-v1-protocol.c ../pointer/wlr-virtual-pointer-unstable-v1-protocol.c $$(pkg-config --cflags --libs wayland-client xkbcommon) -lm
clean:
	rm -f omabox-held
.PHONY: clean
