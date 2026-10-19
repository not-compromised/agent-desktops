/* Agent Desktops endpoint guard. The lease owner validates the current generation
 * before spawning a helper. This guard refuses host displays and stale aliases. */
#ifndef AGENT_ENDPOINT_H
#define AGENT_ENDPOINT_H
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <wayland-client.h>
#include <unistd.h>

static inline int agent_owned(const char *path, struct stat *st) {
    return stat(path, st) == 0 && st->st_uid == getuid() && !(st->st_mode & 0022);
}

struct agent_endpoint {
    char path[PATH_MAX];
    dev_t device;
    ino_t inode;
};

static inline int agent_endpoint_snapshot(struct agent_endpoint *endpoint) {
    const char *slot = getenv("AGENT_DESKTOP"), *display = getenv("WAYLAND_DISPLAY");
    const char *runtime = getenv("XDG_RUNTIME_DIR");
    if (!slot || !*slot || slot[0] == '0' || strlen(slot) > 8 ||
        strspn(slot, "0123456789") != strlen(slot) || !display || !runtime ||
        runtime[0] != '/' || getenv("WAYLAND_SOCKET")) return 0;
    char expected[64], root[PATH_MAX], alias[PATH_MAX], socket[PATH_MAX], metadata[PATH_MAX];
    snprintf(expected, sizeof(expected), "wayland-agent-%s", slot);
    if (strcmp(expected, display) || !realpath(runtime, root) || strcmp(root, runtime)) return 0;
    struct stat st;
    if (!agent_owned(root, &st) || !S_ISDIR(st.st_mode) || (st.st_mode & 0007)) return 0;
    if (snprintf(alias, sizeof(alias), "%s/%s", root, display) >= (int)sizeof(alias) ||
        !realpath(alias, socket) || !agent_owned(socket, &st) || !S_ISSOCK(st.st_mode)) return 0;
    if (endpoint) {
        strcpy(endpoint->path, socket);
        endpoint->device = st.st_dev;
        endpoint->inode = st.st_ino;
    }
    size_t n = strlen(root);
    if (strncmp(root, socket, n) || socket[n] != '/' || strchr(socket + n + 1, '/')) return 0;
    const char *instance = getenv("AGENT_DESKTOP_INSTANCE");
    if (!instance) return 0;
    {
        char link[PATH_MAX], resolved[PATH_MAX];
        if (!*instance || strchr(instance, '/') ||
            snprintf(link, sizeof(link), "%s/hypr/agent-%s", root, slot) >= (int)sizeof(link) ||
            !realpath(link, resolved) || !agent_owned(resolved, &st) || !S_ISDIR(st.st_mode)) return 0;
        const char *base = strrchr(resolved, '/');
        if (!base || strcmp(base + 1, instance)) return 0;
    }
    if (snprintf(metadata, sizeof(metadata), "%s/agent-desktop/%s/nest", root, slot) >= (int)sizeof(metadata) ||
        !agent_owned(metadata, &st) || !S_ISREG(st.st_mode)) return 0;
    FILE *file = fopen(metadata, "r");
    if (!file) return 0;
    char line[PATH_MAX + 64];
    int matches = 0;
    while (fgets(line, sizeof(line), file)) {
        const char prefix[] = "NEST_WAYLAND_DISPLAY=";
        if (strncmp(line, prefix, sizeof(prefix) - 1)) continue;
        char *value = line + sizeof(prefix) - 1;
        value[strcspn(value, "\r\n")] = 0;
        if (!strcmp(value, socket + n + 1)) matches++;
        else { matches = -1; break; }
    }
    fclose(file);
    return matches == 1;
}
static inline int agent_desktop_endpoint(void) {
    return agent_endpoint_snapshot(NULL);
}

/* Connect the concrete socket, then check the generation and inode again before
 * sending any protocol requests. A later alias change cannot retarget this FD. */
static inline struct wl_display *agent_desktop_connect(void) {
    struct agent_endpoint before, after;
    if (!agent_endpoint_snapshot(&before)) return NULL;
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    if (strlen(before.path) >= sizeof(address.sun_path)) return NULL;
    strcpy(address.sun_path, before.path);
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) return NULL;
    int rc = connect(fd, (struct sockaddr *)&address, sizeof(address));
    if (rc < 0 && errno == EINPROGRESS) {
        struct pollfd p = {.fd = fd, .events = POLLOUT};
        int error = 0;
        socklen_t length = sizeof(error);
        rc = poll(&p, 1, 1000) == 1 && getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) == 0 && !error ? 0 : -1;
    }
    struct ucred peer;
    socklen_t length = sizeof(peer);
    if (rc < 0 || getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &length) < 0 ||
        peer.uid != getuid() || !agent_endpoint_snapshot(&after) ||
        strcmp(before.path, after.path) || before.device != after.device || before.inode != after.inode) {
        close(fd);
        return NULL;
    }
    return wl_display_connect_to_fd(fd);
}
#endif
