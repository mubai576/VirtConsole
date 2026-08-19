#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>

#include "linux-dmabuf-v1-client-protocol.h"
#include "xdg-shell-client-protocol.h"

typedef struct {
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    uint32_t fourcc;
    uint64_t modifier;
    uint8_t y0_top;
} FrameInfo;

struct app {
    struct wl_display *display;
    struct wl_compositor *compositor;
    struct xdg_wm_base *wm_base;
    struct zwp_linux_dmabuf_v1 *dmabuf;
    struct wl_surface *surface;
    struct xdg_surface *xdg_surface;
    struct xdg_toplevel *toplevel;
    struct wl_buffer *buffer;
    int configured;
    int running;
    int buffer_released;
};

static void wm_base_ping(void *data, struct xdg_wm_base *wm_base,
                         uint32_t serial)
{
    (void)data;
    xdg_wm_base_pong(wm_base, serial);
}

static const struct xdg_wm_base_listener wm_base_listener = {
    .ping = wm_base_ping,
};

static void dmabuf_format(void *data, struct zwp_linux_dmabuf_v1 *dmabuf,
                          uint32_t format)
{
    (void)data;
    (void)dmabuf;
    (void)format;
}

static void dmabuf_modifier(void *data, struct zwp_linux_dmabuf_v1 *dmabuf,
                            uint32_t format, uint32_t modifier_hi,
                            uint32_t modifier_lo)
{
    (void)data;
    (void)dmabuf;
    (void)format;
    (void)modifier_hi;
    (void)modifier_lo;
}

static const struct zwp_linux_dmabuf_v1_listener dmabuf_listener = {
    .format = dmabuf_format,
    .modifier = dmabuf_modifier,
};

static void registry_global(void *data, struct wl_registry *registry,
                            uint32_t name, const char *interface,
                            uint32_t version)
{
    struct app *app = data;

    if (strcmp(interface, wl_compositor_interface.name) == 0) {
        uint32_t bind_version = version < 4 ? version : 4;
        app->compositor = wl_registry_bind(
            registry, name, &wl_compositor_interface, bind_version);
    } else if (strcmp(interface, xdg_wm_base_interface.name) == 0) {
        app->wm_base = wl_registry_bind(
            registry, name, &xdg_wm_base_interface, 1);
        xdg_wm_base_add_listener(app->wm_base, &wm_base_listener, app);
    } else if (strcmp(interface, zwp_linux_dmabuf_v1_interface.name) == 0) {
        uint32_t bind_version = version < 3 ? version : 3;
        app->dmabuf = wl_registry_bind(
            registry, name, &zwp_linux_dmabuf_v1_interface, bind_version);
        zwp_linux_dmabuf_v1_add_listener(
            app->dmabuf, &dmabuf_listener, app);
    }
}

static void registry_global_remove(void *data, struct wl_registry *registry,
                                   uint32_t name)
{
    (void)data;
    (void)registry;
    (void)name;
}

static const struct wl_registry_listener registry_listener = {
    .global = registry_global,
    .global_remove = registry_global_remove,
};

static void xdg_surface_configure(void *data, struct xdg_surface *surface,
                                  uint32_t serial)
{
    struct app *app = data;
    xdg_surface_ack_configure(surface, serial);
    app->configured = 1;
}

static const struct xdg_surface_listener xdg_surface_listener = {
    .configure = xdg_surface_configure,
};

static void toplevel_configure(void *data, struct xdg_toplevel *toplevel,
                               int32_t width, int32_t height,
                               struct wl_array *states)
{
    (void)data;
    (void)toplevel;
    (void)width;
    (void)height;
    (void)states;
}

static void toplevel_close(void *data, struct xdg_toplevel *toplevel)
{
    struct app *app = data;
    (void)toplevel;
    app->running = 0;
}

static const struct xdg_toplevel_listener toplevel_listener = {
    .configure = toplevel_configure,
    .close = toplevel_close,
};

static void buffer_release(void *data, struct wl_buffer *buffer)
{
    struct app *app = data;
    (void)buffer;
    app->buffer_released = 1;
}

static const struct wl_buffer_listener buffer_listener = {
    .release = buffer_release,
};

static int connect_export_socket(const char *path)
{
    struct sockaddr_un addr = {0};
    if (strlen(path) >= sizeof(addr.sun_path)) {
        fprintf(stderr, "socket path is too long\n");
        return -1;
    }

    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0)
        return -1;
    addr.sun_family = AF_UNIX;
    memcpy(addr.sun_path, path, strlen(path) + 1);

    for (int attempt = 0; attempt < 100; attempt++) {
        if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0)
            return fd;
        if (errno != ENOENT && errno != ECONNREFUSED)
            break;
        struct timespec pause = {.tv_nsec = 100000000};
        nanosleep(&pause, NULL);
    }
    close(fd);
    return -1;
}

static int recv_frame(int socket_fd, FrameInfo *info)
{
    ssize_t meta = recv(socket_fd, info, sizeof(*info), MSG_WAITALL);
    if (meta != (ssize_t)sizeof(*info)) {
        fprintf(stderr, "failed to receive frame metadata: %zd\n", meta);
        return -1;
    }

    char payload;
    struct iovec iov = {.iov_base = &payload, .iov_len = 1};
    char control[CMSG_SPACE(sizeof(int))] = {0};
    struct msghdr message = {
        .msg_iov = &iov,
        .msg_iovlen = 1,
        .msg_control = control,
        .msg_controllen = sizeof(control),
    };
    if (recvmsg(socket_fd, &message, 0) != 1) {
        perror("recvmsg");
        return -1;
    }
    struct cmsghdr *cmsg = CMSG_FIRSTHDR(&message);
    if (!cmsg || cmsg->cmsg_level != SOL_SOCKET ||
        cmsg->cmsg_type != SCM_RIGHTS) {
        fprintf(stderr, "SCM_RIGHTS fd was not received\n");
        return -1;
    }
    int dmabuf_fd;
    memcpy(&dmabuf_fd, CMSG_DATA(cmsg), sizeof(dmabuf_fd));
    return dmabuf_fd;
}

static int setup_wayland(struct app *app)
{
    app->display = wl_display_connect(NULL);
    if (!app->display)
        return -1;

    struct wl_registry *registry = wl_display_get_registry(app->display);
    wl_registry_add_listener(registry, &registry_listener, app);
    if (wl_display_roundtrip(app->display) < 0 || !app->compositor ||
        !app->wm_base || !app->dmabuf) {
        fprintf(stderr, "required Wayland globals are unavailable\n");
        wl_registry_destroy(registry);
        return -1;
    }
    wl_registry_destroy(registry);

    app->surface = wl_compositor_create_surface(app->compositor);
    app->xdg_surface = xdg_wm_base_get_xdg_surface(
        app->wm_base, app->surface);
    xdg_surface_add_listener(
        app->xdg_surface, &xdg_surface_listener, app);
    app->toplevel = xdg_surface_get_toplevel(app->xdg_surface);
    xdg_toplevel_add_listener(app->toplevel, &toplevel_listener, app);
    xdg_toplevel_set_title(app->toplevel, "VirtConsole DMABUF probe");
    xdg_toplevel_set_fullscreen(app->toplevel, NULL);

    struct wl_region *empty = wl_compositor_create_region(app->compositor);
    wl_surface_set_input_region(app->surface, empty);
    wl_region_destroy(empty);
    wl_surface_commit(app->surface);
    while (!app->configured) {
        if (wl_display_dispatch(app->display) < 0)
            return -1;
    }
    return 0;
}

static int import_frame(struct app *app, int fd, const FrameInfo *info)
{
    struct zwp_linux_buffer_params_v1 *params =
        zwp_linux_dmabuf_v1_create_params(app->dmabuf);
    uint32_t flags = info->y0_top
        ? 0
        : ZWP_LINUX_BUFFER_PARAMS_V1_FLAGS_Y_INVERT;
    zwp_linux_buffer_params_v1_add(
        params, fd, 0, 0, info->stride,
        (uint32_t)(info->modifier >> 32), (uint32_t)info->modifier);
    app->buffer = zwp_linux_buffer_params_v1_create_immed(
        params, (int32_t)info->width, (int32_t)info->height,
        info->fourcc, flags);
    zwp_linux_buffer_params_v1_destroy(params);
    close(fd);
    if (!app->buffer)
        return -1;
    wl_buffer_add_listener(app->buffer, &buffer_listener, app);

    struct wl_region *opaque = wl_compositor_create_region(app->compositor);
    wl_region_add(opaque, 0, 0, (int32_t)info->width,
                  (int32_t)info->height);
    wl_surface_set_opaque_region(app->surface, opaque);
    wl_region_destroy(opaque);
    wl_surface_attach(app->surface, app->buffer, 0, 0);
    wl_surface_damage_buffer(app->surface, 0, 0, INT32_MAX, INT32_MAX);
    wl_surface_commit(app->surface);

    if (wl_display_roundtrip(app->display) < 0) {
        fprintf(stderr, "compositor rejected the DMABUF\n");
        return -1;
    }
    printf("WAYLAND_IMPORT_ACCEPTED width=%u height=%u stride=%u "
           "fourcc=0x%08x modifier=0x%016llx y0_top=%u\n",
           info->width, info->height, info->stride, info->fourcc,
           (unsigned long long)info->modifier, info->y0_top);
    fflush(stdout);
    return 0;
}

static void redraw_loop(struct app *app, unsigned int seconds)
{
    const unsigned int frames = seconds * 60;
    const struct timespec frame_time = {.tv_nsec = 16666667};
    int display_fd = wl_display_get_fd(app->display);

    app->running = 1;
    for (unsigned int frame = 0; app->running && frame < frames; frame++) {
        wl_surface_damage_buffer(app->surface, 0, 0, INT32_MAX, INT32_MAX);
        wl_surface_commit(app->surface);
        if (wl_display_flush(app->display) < 0)
            break;

        struct pollfd poll_fd = {.fd = display_fd, .events = POLLIN};
        if (poll(&poll_fd, 1, 0) > 0 && (poll_fd.revents & POLLIN)) {
            if (wl_display_dispatch(app->display) < 0)
                break;
        } else {
            wl_display_dispatch_pending(app->display);
        }
        nanosleep(&frame_time, NULL);
    }
}

static void cleanup(struct app *app)
{
    if (app->buffer)
        wl_buffer_destroy(app->buffer);
    if (app->toplevel)
        xdg_toplevel_destroy(app->toplevel);
    if (app->xdg_surface)
        xdg_surface_destroy(app->xdg_surface);
    if (app->surface)
        wl_surface_destroy(app->surface);
    if (app->dmabuf)
        zwp_linux_dmabuf_v1_destroy(app->dmabuf);
    if (app->wm_base)
        xdg_wm_base_destroy(app->wm_base);
    if (app->compositor)
        wl_compositor_destroy(app->compositor);
    if (app->display)
        wl_display_disconnect(app->display);
}

int main(int argc, char **argv)
{
    if (argc < 2 || argc > 3) {
        fprintf(stderr, "usage: %s <dmabuf-export-socket> [seconds]\n",
                argv[0]);
        return 2;
    }
    unsigned int seconds = argc == 3 ? (unsigned int)strtoul(argv[2], NULL, 10)
                                     : 30;
    if (seconds == 0)
        seconds = 30;

    int socket_fd = connect_export_socket(argv[1]);
    if (socket_fd < 0) {
        perror("connect export socket");
        return 3;
    }
    FrameInfo info = {0};
    int dmabuf_fd = recv_frame(socket_fd, &info);
    close(socket_fd);
    if (dmabuf_fd < 0)
        return 4;

    struct app app = {0};
    if (setup_wayland(&app) < 0) {
        close(dmabuf_fd);
        cleanup(&app);
        return 5;
    }
    if (import_frame(&app, dmabuf_fd, &info) < 0) {
        cleanup(&app);
        return 6;
    }
    redraw_loop(&app, seconds);
    printf("WAYLAND_DISPLAY_COMPLETE released=%d\n", app.buffer_released);
    cleanup(&app);
    return 0;
}
