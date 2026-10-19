/* Keep the proven keyboard mapping and pointer protocol in one device owner.
 * They remain private implementation details; no persistent mode is added to
 * the standalone helpers. Text and commands arrive on stdin, never argv. */
#define main standalone_keyboard_main
#include "../keyboard/keyboard.c"
#undef main
#define seat ptr_seat
#define manager ptr_manager
#define global ptr_global
#define global_remove ptr_global_remove
#define registry_listener ptr_registry_listener
#define now_ms ptr_now_ms
#define usage ptr_usage
#define num ptr_num
#define sync_or_die ptr_sync_or_die
#define sleep_ms ptr_sleep_ms
#define display ptr_display
#define main standalone_pointer_main
#include "../pointer/pointer.c"
#undef main
#undef seat
#undef manager
#undef global
#undef global_remove
#undef registry_listener
#undef now_ms
#undef usage
#undef num
#undef sync_or_die
#undef sleep_ms
#undef display
#include <sys/prctl.h>

static struct zwlr_virtual_pointer_v1 *pointer_device;
static xkb_keycode_t pressed_keys[16];
static uint32_t pressed_buttons[3];
static int key_count, button_count, watchdog_fd = -1;

static void deadline(long ms) {
    if (watchdog_fd >= 0 && write(watchdog_fd, &ms, sizeof(ms)) != sizeof(ms)) exit(1);
}

static void watchdog(int fd, pid_t owner) {
    prctl(PR_SET_PDEATHSIG, SIGTERM);
    if (getppid() != owner) _exit(0);
    long ms = -1;
    for (;;) {
        struct pollfd p = {fd, POLLIN, 0};
        int r = poll(&p, 1, ms > 0 ? (int)ms : -1);
        if (r < 0 && errno == EINTR) continue;
        if (r < 0) _exit(1);
        if (r == 0) {
            kill(owner, SIGALRM);
            if (poll(&p, 1, 500) <= 0) { kill(owner, SIGKILL); _exit(1); }
        }
        if (read(fd, &ms, sizeof(ms)) != sizeof(ms)) _exit(0);
    }
}

static int start_watchdog(void) {
    int pipes[2];
    if (pipe2(pipes, O_CLOEXEC)) return 0;
    pid_t owner = getpid(), pid = fork();
    if (pid < 0) return 0;
    if (!pid) {
        close(pipes[1]);
        // The watchdog must not keep input devices or the caller's pipes alive.
        for (int fd = 0; fd < 1024; fd++) if (fd != pipes[0]) close(fd);
        watchdog(pipes[0], owner);
        _exit(0);
    }
    close(pipes[0]); watchdog_fd = pipes[1];
    return 1;
}

static void clear_state(void) {
    for (int i = button_count - 1; i >= 0; i--)
        zwlr_virtual_pointer_v1_button(pointer_device, now_ms(), pressed_buttons[i], WL_POINTER_BUTTON_STATE_RELEASED);
    zwlr_virtual_pointer_v1_frame(pointer_device);
    for (int i = key_count - 1; i >= 0; i--) key(pressed_keys[i], 0);
    set_mods(0);
    key_count = button_count = 0;
    kept = kept_mask = 0;
    sync_or_die(); ptr_sync_or_die();
    deadline(0);
}

static int is_pressed(xkb_keycode_t code) {
    for (int i = 0; i < key_count; i++) if (pressed_keys[i] == code) return 1;
    return 0;
}

static uint32_t mask_for_codes(const xkb_keycode_t *codes, int count) {
    struct xkb_state *state = xkb_state_new(keymap);
    if (!state) exit(1);
    for (int i = 0; i < count; i++) xkb_state_update_key(state, codes[i], XKB_KEY_DOWN);
    uint32_t mask = xkb_state_serialize_mods(state, XKB_STATE_MODS_DEPRESSED);
    xkb_state_unref(state);
    return mask;
}

static int ordinary_keys(void) {
    int count = 0;
    for (int i = 0; i < key_count; i++) count += mask_for_codes(&pressed_keys[i], 1) == 0;
    return count;
}

static int replace_state(long ms, char *keys, char *btns) {
    xkb_keycode_t next_keys[16]; uint32_t next_buttons[3];
    int nk = 0, nb = 0;
    char *save;
    for (char *name = strtok_r(keys, ",", &save); name; name = strtok_r(NULL, ",", &save)) {
        const char *as; struct hit h;
        if (nk == 16 || !find_keysym(key_sym(name, &as), &h) || h.mask) return 0;
        for (int i = 0; i < nk; i++) if (next_keys[i] == h.code) return 0;
        next_keys[nk++] = h.code;
    }
    for (char *name = strtok_r(btns, ",", &save); name; name = strtok_r(NULL, ",", &save)) {
        if (nb == 3 || (strcmp(name, "left") && strcmp(name, "middle") && strcmp(name, "right"))) return 0;
        uint32_t code = button_code(name);
        for (int i = 0; i < nb; i++) if (next_buttons[i] == code) return 0;
        next_buttons[nb++] = code;
    }
    if (ms < 100 || ms > 30000) return 0;
    // Keep unchanged buttons/keys down during replacement. A button release
    // followed by a new press would silently break an ongoing drag.
    deadline(nk || nb ? ms : 0);
    for (int i = 0; i < key_count; i++) {
        int found = 0; for (int j = 0; j < nk; j++) found |= pressed_keys[i] == next_keys[j];
        if (!found) key(pressed_keys[i], 0);
    }
    for (int i = 0; i < button_count; i++) {
        int found = 0; for (int j = 0; j < nb; j++) found |= pressed_buttons[i] == next_buttons[j];
        if (!found) zwlr_virtual_pointer_v1_button(pointer_device, now_ms(), pressed_buttons[i], WL_POINTER_BUTTON_STATE_RELEASED);
    }
    for (int j = 0; j < nk; j++) if (!is_pressed(next_keys[j])) key(next_keys[j], 1);
    for (int j = 0; j < nb; j++) {
        int found = 0; for (int i = 0; i < button_count; i++) found |= pressed_buttons[i] == next_buttons[j];
        if (!found) zwlr_virtual_pointer_v1_button(pointer_device, now_ms(), next_buttons[j], WL_POINTER_BUTTON_STATE_PRESSED);
    }
    memcpy(pressed_keys, next_keys, (size_t)nk * sizeof(*next_keys)); key_count = nk;
    memcpy(pressed_buttons, next_buttons, (size_t)nb * sizeof(*next_buttons)); button_count = nb;
    kept_mask = mask_for_codes(pressed_keys, key_count);
    kept = held_for(kept_mask);
    set_mods(kept_mask); zwlr_virtual_pointer_v1_frame(pointer_device);
    sync_or_die(); ptr_sync_or_die();
    return 1;
}

static char *unhex(char *s) {
    if (!strcmp(s, "-")) { *s = 0; return s; }
    size_t n = strlen(s);
    if (n % 2) return NULL;
    for (size_t i = 0; i < n / 2; i++) {
        char pair[3] = {s[i * 2], s[i * 2 + 1], 0}, *end;
        long c = strtol(pair, &end, 16);
        if (*end || !c) return NULL;
        s[i] = (char)c;
    }
    s[n / 2] = 0; return s;
}

static int move_pointer(char *x, char *y) {
    char *args[] = {"move", x, y};
    commands(pointer_device, 3, args, 0, 2560, 1440, 0);
    commands(pointer_device, 3, args, 0, 2560, 1440, 1);
    return 1;
}

static int execute(char *kind, int n, char **a) {
    if (!strcmp(kind, "SET") && n == 3) return replace_state(num(a[0], 100, 30000), a[1], a[2]);
    if (!strcmp(kind, "RELEASE") && n == 0) { clear_state(); return 1; }
    if (!strcmp(kind, "MOVE") && n == 2) return move_pointer(a[0], a[1]);
    if (!strcmp(kind, "KEY") && n == 1) {
        char *name = strrchr(a[0], '+'); name = name ? name + 1 : a[0];
        const char *as; struct hit h;
        if (!find_keysym(key_sym(name, &as), &h) || is_pressed(h.code)) return 0;
        return do_combo(a[0], 0) && do_combo(a[0], 1);
    }
    if (!strcmp(kind, "TYPE") && n == 1) {
        char *args[] = {"-t", a[0]};
        if (!text_controls_ok(2, args, 0) || !do_text(a[0], 0)) return 0;
        // A held ordinary key cannot safely be tapped and released by typing.
        if (ordinary_keys()) return 0;
        const unsigned char *p = (unsigned char *)a[0];
        while (*p && !stop) {
            uint32_t cp; struct hit h;
            if (!decode(&p, &cp) || !find_keysym((xkb_keysym_t)text_keysym(cp), &h) || !chord(held_for(h.mask), h.code, 1)) return 0;
        }
        return !stop;
    }
    if ((!strcmp(kind, "CLICK") && n == 3) || (!strcmp(kind, "DRAG") && n == 6)) {
        int drag = !strcmp(kind, "DRAG");
        char *button = a[drag ? 4 : 2];
        if (!is_button(button)) return 0;
        uint32_t code = button_code(button);
        for (int i = 0; i < button_count; i++) if (pressed_buttons[i] == code) return 0;
        move_pointer(a[0], a[1]);
        if (drag) {
            long x = num(a[0], 0, 2559), y = num(a[1], 0, 1439);
            long tx = num(a[2], 0, 2559), ty = num(a[3], 0, 1439), ms = num(a[5], 100, 2000);
            zwlr_virtual_pointer_v1_button(pointer_device, now_ms(), code, WL_POINTER_BUTTON_STATE_PRESSED);
            zwlr_virtual_pointer_v1_frame(pointer_device); ptr_sync_or_die();
            for (int i = 1; i <= 10 && !stop; i++) {
                zwlr_virtual_pointer_v1_motion_absolute(pointer_device, now_ms(), (uint32_t)(x + (tx - x) * i / 10), (uint32_t)(y + (ty - y) * i / 10), 2560, 1440);
                zwlr_virtual_pointer_v1_frame(pointer_device); ptr_sync_or_die(); sleep_ms(ms / 10);
            }
            zwlr_virtual_pointer_v1_button(pointer_device, now_ms(), code, WL_POINTER_BUTTON_STATE_RELEASED);
            zwlr_virtual_pointer_v1_frame(pointer_device); ptr_sync_or_die();
            return !stop;
        }
        char *args[] = {"click", button}; commands(pointer_device, 2, args, 0, 2560, 1440, 1);
        return 1;
    }
    if (!strcmp(kind, "SCROLL") && n == 4) {
        move_pointer(a[0], a[1]);
        long dy = num(a[2], -100, 100), dx = num(a[3], -100, 100);
        if (dy) scroll(pointer_device, WL_POINTER_AXIS_VERTICAL_SCROLL, (double)dy, -1);
        if (dx) scroll(pointer_device, WL_POINTER_AXIS_HORIZONTAL_SCROLL, (double)dx, -1);
        ptr_sync_or_die(); return 1;
    }
    return 0;
}

#ifndef AGENT_HELD_TEST
int main(void) {
    if (!agent_desktop_endpoint()) { fprintf(stderr, "refusing non-agent Wayland endpoint\n"); return 2; }
    struct sigaction sa = {.sa_handler = on_signal};
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, NULL); sigaction(SIGINT, &sa, NULL); sigaction(SIGHUP, &sa, NULL); sigaction(SIGALRM, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);
    struct xkb_context *ctx = xkb_context_new(XKB_CONTEXT_NO_ENVIRONMENT_NAMES);
    struct xkb_rule_names names = {.layout = "us"};
    keymap = ctx ? xkb_keymap_new_from_names(ctx, &names, XKB_KEYMAP_COMPILE_NO_FLAGS) : NULL;
    if (!keymap) return 1;
    for (size_t m = 0; m < NMODS; m++) pressable |= mod_mask((int)m);
    delay_ms = 1;
    if (!kbd_connect()) return 1;
    spend(0);
    ptr_display = agent_desktop_connect();
    if (!ptr_display) return 1;
    struct wl_registry *registry = wl_display_get_registry(ptr_display);
    wl_registry_add_listener(registry, &ptr_registry_listener, NULL); ptr_sync_or_die();
    if (!ptr_seat || !ptr_manager) return 1;
    pointer_device = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(ptr_manager, ptr_seat);
    for (int dx = 1; dx >= -1; dx -= 2) {
        zwlr_virtual_pointer_v1_motion(pointer_device, now_ms(), wl_fixed_from_int(dx), 0);
        zwlr_virtual_pointer_v1_frame(pointer_device); ptr_sync_or_die();
    }
    if (!start_watchdog()) return 1;
    setvbuf(stdin, NULL, _IONBF, 0); setvbuf(stdout, NULL, _IOLBF, 0);
    char *line = NULL; size_t capacity = 0;
    for (;;) {
        if (stop == SIGALRM) { clear_state(); stop = 0; puts("expired"); }
        else if (stop) break;
        ssize_t length = getline(&line, &capacity, stdin);
        if (length < 0) { if (errno == EINTR) { clearerr(stdin); continue; } break; }
        if (length > 100000) { clear_state(); puts("error command too large"); break; }
        line[strcspn(line, "\r\n")] = 0;
        char *save, *kind = strtok_r(line, " ", &save), *args[8]; int n = 0, valid = !!kind;
        for (char *part = strtok_r(NULL, " ", &save); part; part = strtok_r(NULL, " ", &save)) {
            if (n == 8 || !(args[n] = unhex(part))) { valid = 0; break; } n++;
        }
        if (!valid || !execute(kind, n, args) || stop) {
            int expired = stop == SIGALRM;
            clear_state();
            if (expired) { stop = 0; puts("expired"); }
            puts(expired ? "error held input deadline expired" : "error invalid or conflicting resident input command");
            break;
        }
        puts("ok");
    }
    clear_state(); free(line);
    zwlr_virtual_pointer_v1_destroy(pointer_device); ptr_sync_or_die();
    zwp_virtual_keyboard_v1_destroy(kbd); sync_or_die();
    wl_display_disconnect(ptr_display); wl_display_disconnect(display);
    close(watchdog_fd);
    return 0;
}
#endif
