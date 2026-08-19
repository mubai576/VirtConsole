#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>

#include "linux-dmabuf-v1-client-protocol.h"

struct state {
    struct zwp_linux_dmabuf_v1 *dmabuf;
    unsigned int formats;
    unsigned int modifiers;
};

static void print_fourcc(uint32_t format, char text[5])
{
    text[0] = (char)(format & 0xff);
    text[1] = (char)((format >> 8) & 0xff);
    text[2] = (char)((format >> 16) & 0xff);
    text[3] = (char)((format >> 24) & 0xff);
    text[4] = '\0';
}

static void dmabuf_format(void *data, struct zwp_linux_dmabuf_v1 *dmabuf,
                          uint32_t format)
{
    struct state *state = data;
    char fourcc[5];

    (void)dmabuf;
    print_fourcc(format, fourcc);
    printf("FORMAT fourcc=%s value=0x%08x\n", fourcc, format);
    state->formats++;
}

static void dmabuf_modifier(void *data, struct zwp_linux_dmabuf_v1 *dmabuf,
                            uint32_t format, uint32_t modifier_hi,
                            uint32_t modifier_lo)
{
    struct state *state = data;
    uint64_t modifier = ((uint64_t)modifier_hi << 32) | modifier_lo;
    char fourcc[5];

    (void)dmabuf;
    print_fourcc(format, fourcc);
    printf("MODIFIER fourcc=%s value=0x%08x modifier=0x%016llx\n",
           fourcc, format, (unsigned long long)modifier);
    state->modifiers++;
}

static const struct zwp_linux_dmabuf_v1_listener dmabuf_listener = {
    .format = dmabuf_format,
    .modifier = dmabuf_modifier,
};

static void registry_global(void *data, struct wl_registry *registry,
                            uint32_t name, const char *interface,
                            uint32_t version)
{
    struct state *state = data;

    if (strcmp(interface, zwp_linux_dmabuf_v1_interface.name) != 0)
        return;

    uint32_t bind_version = version < 3 ? version : 3;
    state->dmabuf = wl_registry_bind(
        registry, name, &zwp_linux_dmabuf_v1_interface, bind_version);
    zwp_linux_dmabuf_v1_add_listener(state->dmabuf, &dmabuf_listener, state);
    printf("GLOBAL interface=%s server_version=%u bound_version=%u\n",
           interface, version, bind_version);
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

int main(void)
{
    struct state state = {0};
    struct wl_display *display = wl_display_connect(NULL);
    if (!display) {
        fprintf(stderr, "failed to connect to Wayland display\n");
        return 2;
    }

    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, &state);
    if (wl_display_roundtrip(display) < 0 || !state.dmabuf ||
        wl_display_roundtrip(display) < 0) {
        fprintf(stderr, "linux-dmabuf discovery failed\n");
        wl_registry_destroy(registry);
        wl_display_disconnect(display);
        return 3;
    }

    printf("SUMMARY formats=%u modifiers=%u\n", state.formats,
           state.modifiers);
    zwp_linux_dmabuf_v1_destroy(state.dmabuf);
    wl_registry_destroy(registry);
    wl_display_disconnect(display);
    return state.modifiers == 0 ? 4 : 0;
}
