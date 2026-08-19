#include <errno.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wayland-client.h>

#include "linux-dmabuf-v1-client-protocol.h"
#include "viewporter-client-protocol.h"

struct vc_dmabuf_overlay;

struct vc_buffer {
    struct vc_dmabuf_overlay *owner;
    struct wl_buffer *buffer;
    struct vc_buffer *next;
    bool current;
    bool released;
};

struct vc_dmabuf_overlay {
    struct wl_display *display;
    struct wl_compositor *compositor;
    struct wl_subcompositor *subcompositor;
    struct zwp_linux_dmabuf_v1 *dmabuf;
    struct wp_viewporter *viewporter;
    struct wl_surface *surface;
    struct wl_subsurface *subsurface;
    struct wp_viewport *viewport;
    struct vc_buffer *buffers;
    struct vc_buffer *current;
};

static void set_error(char *error, size_t error_len, const char *format, ...)
{
    if (!error || error_len == 0)
        return;
    va_list args;
    va_start(args, format);
    vsnprintf(error, error_len, format, args);
    va_end(args);
}

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
    struct vc_dmabuf_overlay *overlay = data;

    if (strcmp(interface, wl_compositor_interface.name) == 0) {
        uint32_t bind_version = version < 4 ? version : 4;
        overlay->compositor = wl_registry_bind(
            registry, name, &wl_compositor_interface, bind_version);
    } else if (strcmp(interface, wl_subcompositor_interface.name) == 0) {
        overlay->subcompositor = wl_registry_bind(
            registry, name, &wl_subcompositor_interface, 1);
    } else if (strcmp(interface, zwp_linux_dmabuf_v1_interface.name) == 0) {
        uint32_t bind_version = version < 3 ? version : 3;
        overlay->dmabuf = wl_registry_bind(
            registry, name, &zwp_linux_dmabuf_v1_interface, bind_version);
        zwp_linux_dmabuf_v1_add_listener(
            overlay->dmabuf, &dmabuf_listener, overlay);
    } else if (strcmp(interface, wp_viewporter_interface.name) == 0) {
        overlay->viewporter = wl_registry_bind(
            registry, name, &wp_viewporter_interface, 1);
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

static void unlink_buffer(struct vc_dmabuf_overlay *overlay,
                          struct vc_buffer *entry)
{
    struct vc_buffer **cursor = &overlay->buffers;
    while (*cursor && *cursor != entry)
        cursor = &(*cursor)->next;
    if (*cursor == entry)
        *cursor = entry->next;
}

static void destroy_buffer(struct vc_buffer *entry)
{
    if (!entry)
        return;
    unlink_buffer(entry->owner, entry);
    wl_buffer_destroy(entry->buffer);
    free(entry);
}

static void buffer_release(void *data, struct wl_buffer *buffer)
{
    struct vc_buffer *entry = data;
    (void)buffer;
    entry->released = true;
    if (!entry->current)
        destroy_buffer(entry);
}

static const struct wl_buffer_listener buffer_listener = {
    .release = buffer_release,
};

void *vc_dmabuf_overlay_create(void *display_ptr, void *parent_surface_ptr,
                               int32_t target_width, int32_t target_height,
                               char *error, size_t error_len)
{
    struct wl_display *display = display_ptr;
    struct wl_surface *parent_surface = parent_surface_ptr;
    if (!display || !parent_surface || target_width <= 0 || target_height <= 0) {
        set_error(error, error_len, "Wayland display or parent surface is null");
        return NULL;
    }

    struct vc_dmabuf_overlay *overlay = calloc(1, sizeof(*overlay));
    if (!overlay) {
        set_error(error, error_len, "overlay allocation failed");
        return NULL;
    }
    overlay->display = display;

    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, overlay);
    if (wl_display_roundtrip(display) < 0 || !overlay->compositor ||
        !overlay->subcompositor || !overlay->dmabuf || !overlay->viewporter) {
        set_error(error, error_len,
                  "required compositor/subcompositor/linux-dmabuf/viewporter global is unavailable");
        wl_registry_destroy(registry);
        free(overlay);
        return NULL;
    }
    wl_registry_destroy(registry);

    overlay->surface = wl_compositor_create_surface(overlay->compositor);
    if (!overlay->surface) {
        set_error(error, error_len, "failed to create Wayland surface");
        free(overlay);
        return NULL;
    }
    overlay->subsurface = wl_subcompositor_get_subsurface(
        overlay->subcompositor, overlay->surface, parent_surface);
    overlay->viewport = wp_viewporter_get_viewport(
        overlay->viewporter, overlay->surface);
    if (!overlay->subsurface || !overlay->viewport) {
        set_error(error, error_len, "failed to create Wayland subsurface");
        free(overlay);
        return NULL;
    }
    wl_subsurface_set_desync(overlay->subsurface);
    wl_subsurface_set_position(overlay->subsurface, 0, 0);
    wl_subsurface_place_above(overlay->subsurface, parent_surface);
    wp_viewport_set_destination(overlay->viewport, target_width, target_height);

    struct wl_region *empty = wl_compositor_create_region(overlay->compositor);
    wl_surface_set_input_region(overlay->surface, empty);
    wl_region_destroy(empty);
    wl_surface_commit(overlay->surface);
    if (wl_display_flush(display) < 0) {
        set_error(error, error_len, "initial Wayland flush failed: %s",
                  strerror(errno));
        free(overlay);
        return NULL;
    }
    return overlay;
}

int vc_dmabuf_overlay_present(void *overlay_ptr, int fd, uint32_t width,
                              uint32_t height, uint32_t stride,
                              uint32_t fourcc, uint64_t modifier,
                              int y0_top, char *error, size_t error_len)
{
    struct vc_dmabuf_overlay *overlay = overlay_ptr;
    if (!overlay || fd < 0 || width == 0 || height == 0 ||
        width > INT32_MAX || height > INT32_MAX ||
        (uint64_t)stride < (uint64_t)width * 4) {
        if (fd >= 0)
            close(fd);
        set_error(error, error_len, "invalid DMABUF presentation arguments");
        return -1;
    }

    struct zwp_linux_buffer_params_v1 *params =
        zwp_linux_dmabuf_v1_create_params(overlay->dmabuf);
    zwp_linux_buffer_params_v1_add(
        params, fd, 0, 0, stride, (uint32_t)(modifier >> 32),
        (uint32_t)modifier);
    /* QEMU's y0_top bit describes the guest scanout origin, while the
     * linux-dmabuf flag describes a buffer that must be inverted by Weston.
     * For the virgl/NVIDIA dmabuf received here, y0_top=false is already the
     * compositor's top-left orientation; invert only the explicit top-origin
     * case. */
    uint32_t flags = y0_top
        ? ZWP_LINUX_BUFFER_PARAMS_V1_FLAGS_Y_INVERT
        : 0;
    struct wl_buffer *buffer = zwp_linux_buffer_params_v1_create_immed(
        params, (int32_t)width, (int32_t)height, fourcc, flags);
    zwp_linux_buffer_params_v1_destroy(params);
    close(fd);
    if (!buffer) {
        set_error(error, error_len, "linux-dmabuf create_immed returned null");
        return -1;
    }

    struct vc_buffer *entry = calloc(1, sizeof(*entry));
    if (!entry) {
        wl_buffer_destroy(buffer);
        set_error(error, error_len, "buffer tracking allocation failed");
        return -1;
    }
    entry->owner = overlay;
    entry->buffer = buffer;
    entry->current = true;
    entry->next = overlay->buffers;
    overlay->buffers = entry;
    wl_buffer_add_listener(buffer, &buffer_listener, entry);

    struct vc_buffer *previous = overlay->current;
    overlay->current = entry;
    if (previous) {
        previous->current = false;
        if (previous->released)
            destroy_buffer(previous);
    }

    struct wl_region *opaque = wl_compositor_create_region(overlay->compositor);
    wl_region_add(opaque, 0, 0, (int32_t)width, (int32_t)height);
    wl_surface_set_opaque_region(overlay->surface, opaque);
    wl_region_destroy(opaque);
    wl_surface_attach(overlay->surface, buffer, 0, 0);
    wl_surface_damage_buffer(overlay->surface, 0, 0, INT32_MAX, INT32_MAX);
    wl_surface_commit(overlay->surface);
    if (wl_display_flush(overlay->display) < 0 ||
        wl_display_get_error(overlay->display) != 0) {
        set_error(error, error_len, "Wayland rejected DMABUF commit: %s",
                  strerror(errno));
        return -1;
    }
    return 0;
}

void vc_dmabuf_overlay_damage(void *overlay_ptr, int32_t x, int32_t y,
                              int32_t width, int32_t height)
{
    struct vc_dmabuf_overlay *overlay = overlay_ptr;
    if (!overlay || !overlay->current || width <= 0 || height <= 0)
        return;
    overlay->current->released = false;
    wl_surface_attach(overlay->surface, overlay->current->buffer, 0, 0);
    wl_surface_damage_buffer(overlay->surface, x, y, width, height);
    wl_surface_commit(overlay->surface);
    wl_display_flush(overlay->display);
}

void vc_dmabuf_overlay_resize(void *overlay_ptr, int32_t width, int32_t height)
{
    struct vc_dmabuf_overlay *overlay = overlay_ptr;
    if (!overlay || width <= 0 || height <= 0)
        return;
    wp_viewport_set_destination(overlay->viewport, width, height);
    wl_surface_commit(overlay->surface);
    wl_display_flush(overlay->display);
}

void vc_dmabuf_overlay_hide(void *overlay_ptr)
{
    struct vc_dmabuf_overlay *overlay = overlay_ptr;
    if (!overlay)
        return;
    if (overlay->current) {
        overlay->current->current = false;
        if (overlay->current->released)
            destroy_buffer(overlay->current);
        overlay->current = NULL;
    }
    wl_surface_attach(overlay->surface, NULL, 0, 0);
    wl_surface_commit(overlay->surface);
    wl_display_flush(overlay->display);
}

void vc_dmabuf_overlay_destroy(void *overlay_ptr)
{
    struct vc_dmabuf_overlay *overlay = overlay_ptr;
    if (!overlay)
        return;
    vc_dmabuf_overlay_hide(overlay);
    while (overlay->buffers) {
        struct vc_buffer *entry = overlay->buffers;
        overlay->buffers = entry->next;
        wl_buffer_destroy(entry->buffer);
        free(entry);
    }
    wp_viewport_destroy(overlay->viewport);
    wl_subsurface_destroy(overlay->subsurface);
    wl_surface_destroy(overlay->surface);
    zwp_linux_dmabuf_v1_destroy(overlay->dmabuf);
    wp_viewporter_destroy(overlay->viewporter);
    wl_subcompositor_destroy(overlay->subcompositor);
    wl_compositor_destroy(overlay->compositor);
    wl_display_flush(overlay->display);
    free(overlay);
}
