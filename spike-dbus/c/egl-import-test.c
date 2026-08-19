// C6 验证：DMABUF EGL 导入 + glReadPixels 读像素
// 通过 Unix socket (SCM_RIGHTS) 从 spike 探针接收 DMABUF fd，
// 用 eglCreateImageKHR + EGL_EXT_image_dma_buf_import_modifiers 导入，
// 绑定为纹理后 glReadPixels 读回，统计非全黑像素（证明画面真实可读）。
//
// 用法: ./egl-import-test <unix-socket-path>
// 依赖: libegl-dev libgles2-dev
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <stdint.h>
#include <time.h>
#include <signal.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>

// 探针通过 socket 传来的帧元数据 + fd
typedef struct {
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    uint32_t fourcc;
    uint64_t modifier;
    uint8_t y0_top;
} FrameInfo;

static void import_crash_handler(int sig) {
    const char message[] = "IMPORT_VERDICT: CRASH during EGL import/render\n";
    (void)write(STDERR_FILENO, message, sizeof(message) - 1);
    _exit(128 + sig);
}

#ifndef DRM_FORMAT_MOD_LINEAR
#define DRM_FORMAT_MOD_LINEAR 0ULL
#endif

static int recv_fd_with_meta(int sock, FrameInfo *info) {
    // 先收元数据
    ssize_t n = recv(sock, info, sizeof(*info), MSG_WAITALL);
    if (n != (ssize_t)sizeof(*info)) {
        fprintf(stderr, "recv meta failed: %zd (%s)\n", n, strerror(errno));
        return -1;
    }
    // 收带 fd 的 SCM_RIGHTS 消息
    char buf[1];
    struct iovec iov = { buf, sizeof(buf) };
    char cmsgbuf[CMSG_SPACE(sizeof(int))];
    struct msghdr msg = {0};
    msg.msg_iov = &iov;
    msg.msg_iovlen = 1;
    msg.msg_control = cmsgbuf;
    msg.msg_controllen = sizeof(cmsgbuf);
    ssize_t r = recvmsg(sock, &msg, 0);
    if (r < 0) {
        fprintf(stderr, "recvmsg failed: %s\n", strerror(errno));
        return -1;
    }
    struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
    if (!cmsg || cmsg->cmsg_level != SOL_SOCKET || cmsg->cmsg_type != SCM_RIGHTS) {
        fprintf(stderr, "no fd in message\n");
        return -1;
    }
    return *(int *)CMSG_DATA(cmsg);
}

static void check_egl(const char *what, EGLBoolean ok) {
    if (!ok) {
        fprintf(stderr, "EGL %s failed: 0x%x\n", what, eglGetError());
        exit(1);
    }
}

static EGLImage import_dmabuf(EGLDisplay dpy, PFNEGLCREATEIMAGEKHRPROC create_image,
                              const FrameInfo *info, int fd, const char *mode) {
    uint64_t modifier = info->modifier;
    int include_modifier = strcmp(mode, "no-modifier") != 0;
    if (strcmp(mode, "linear") == 0) modifier = DRM_FORMAT_MOD_LINEAR;
    EGLint attrs[32];
    int i = 0;
    attrs[i++] = EGL_LINUX_DMA_BUF_EXT;
    attrs[i++] = EGL_LINUX_DRM_FOURCC_EXT;
    attrs[i++] = (EGLint)info->fourcc;
    attrs[i++] = EGL_WIDTH;
    attrs[i++] = (EGLint)info->width;
    attrs[i++] = EGL_HEIGHT;
    attrs[i++] = (EGLint)info->height;
    attrs[i++] = EGL_DMA_BUF_PLANE0_FD_EXT;
    attrs[i++] = fd;
    attrs[i++] = EGL_DMA_BUF_PLANE0_OFFSET_EXT;
    attrs[i++] = 0;
    attrs[i++] = EGL_DMA_BUF_PLANE0_PITCH_EXT;
    attrs[i++] = (EGLint)info->stride;
    if (include_modifier) {
        attrs[i++] = EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT;
        attrs[i++] = (EGLint)(modifier & 0xFFFFFFFFu);
        attrs[i++] = EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT;
        attrs[i++] = (EGLint)((modifier >> 32) & 0xFFFFFFFFu);
    }
    attrs[i++] = EGL_NONE;
    EGLImage image = create_image(dpy, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT,
                                  (EGLClientBuffer)NULL, attrs);
    if (image == EGL_NO_IMAGE)
        fprintf(stderr, "eglCreateImageKHR mode=%s failed: 0x%x\n", mode, eglGetError());
    return image;
}

static double elapsed_ms(const struct timespec *start, const struct timespec *end) {
    return (end->tv_sec - start->tv_sec) * 1000.0 +
           (end->tv_nsec - start->tv_nsec) / 1000000.0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <unix-socket-path> [original|linear|no-modifier]\n", argv[0]);
        return 2;
    }
    const char *sockpath = argv[1];
    const char *mode = argc >= 3 ? argv[2] : "original";
    signal(SIGSEGV, import_crash_handler);
    signal(SIGABRT, import_crash_handler);
    if (strcmp(mode, "original") != 0 && strcmp(mode, "linear") != 0 && strcmp(mode, "no-modifier") != 0) {
        fprintf(stderr, "unknown mode '%s' (use original, linear, or no-modifier)\n", mode);
        return 2;
    }

    // 连接探针的 socket（带重试：探针可能在 listener 就绪前尚未 accept）
    int sock = -1;
    for (int attempt = 0; attempt < 20; attempt++) {
        sock = socket(AF_UNIX, SOCK_STREAM, 0);
        if (sock < 0) { perror("socket"); return 1; }
        struct sockaddr_un addr;
        memset(&addr, 0, sizeof(addr));
        addr.sun_family = AF_UNIX;
        strncpy(addr.sun_path, sockpath, sizeof(addr.sun_path) - 1);
        if (connect(sock, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
            break;
        }
        close(sock);
        sock = -1;
        usleep(200 * 1000);
    }
    if (sock < 0) {
        fprintf(stderr, "connect failed after retries: %s\n", strerror(errno));
        return 1;
    }

    FrameInfo info;
    int dmabuf = recv_fd_with_meta(sock, &info);
    if (dmabuf < 0) return 1;
    struct stat st;
    if (fstat(dmabuf, &st) != 0) {
        fprintf(stderr, "fstat(dmabuf) failed: %s\n", strerror(errno));
        close(dmabuf);
        return 1;
    }
    printf("received dmabuf fd=%d %ux%u stride=%u fourcc=0x%08X modifier=0x%016llX\n",
           dmabuf, info.width, info.height, info.stride, info.fourcc,
           (unsigned long long)info.modifier);
    printf("y0_top=%u mode=%s fd_type=%s\n", info.y0_top, mode,
           S_ISCHR(st.st_mode) ? "char" : (S_ISREG(st.st_mode) ? "regular" : "other"));
    close(sock);

    if (strcmp(mode, "linear") == 0 && info.modifier != DRM_FORMAT_MOD_LINEAR) {
        fprintf(stderr,
                "IMPORT_VERDICT: FAIL mode=linear reason=source_modifier_not_linear\n");
        close(dmabuf);
        return 1;
    }

    // EGL init：优先 EGL_PLATFORM_DEVICE_EXT（surfaceless，无 X11/Wayland），
    // 退回到 EGL_DEFAULT_DISPLAY
    EGLDisplay dpy = EGL_NO_DISPLAY;
    EGLint major = 0, minor = 0;
    PFNEGLGETPLATFORMDISPLAYEXTPROC eglGetPlatformDisplayEXT =
        (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
    PFNEGLQUERYDEVICESEXTPROC eglQueryDevicesEXT =
        (PFNEGLQUERYDEVICESEXTPROC)eglGetProcAddress("eglQueryDevicesEXT");
    if (eglGetPlatformDisplayEXT && eglQueryDevicesEXT) {
        EGLDeviceEXT devices[4];
        EGLint ndev = 0;
        if (eglQueryDevicesEXT(4, devices, &ndev) && ndev > 0) {
            for (EGLint i = 0; i < ndev; i++) {
                dpy = eglGetPlatformDisplayEXT(EGL_PLATFORM_DEVICE_EXT, devices[i], NULL);
                if (dpy != EGL_NO_DISPLAY && eglInitialize(dpy, &major, &minor)) {
                    printf("using EGL_PLATFORM_DEVICE device[%d], EGL %d.%d\n", i, major, minor);
                    break;
                }
            }
        }
    }
    if (dpy == EGL_NO_DISPLAY) {
        dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
        check_egl("eglGetDisplay", dpy != EGL_NO_DISPLAY);
        check_egl("eglInitialize", eglInitialize(dpy, &major, &minor));
        printf("using EGL_DEFAULT_DISPLAY, EGL %d.%d\n", major, minor);
    }

    // 绑定并选 config
    check_egl("eglBindAPI", eglBindAPI(EGL_OPENGL_ES_API));
    EGLint cfg_attrs[] = {
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
        EGL_NONE
    };
    EGLConfig cfg;
    EGLint ncfg;
    check_egl("eglChooseConfig", eglChooseConfig(dpy, cfg_attrs, &cfg, 1, &ncfg));
    EGLContext ctx = eglCreateContext(dpy, cfg, EGL_NO_CONTEXT, NULL);
    check_egl("eglCreateContext", ctx != EGL_NO_CONTEXT);
    EGLSurface surf = eglCreatePbufferSurface(dpy, cfg, NULL);
    check_egl("eglCreatePbufferSurface", surf != EGL_NO_SURFACE);
    check_egl("eglMakeCurrent", eglMakeCurrent(dpy, surf, surf, ctx));

    // 导入 DMABUF 为 EGLImage (带 modifier 扩展)
    PFNEGLCREATEIMAGEKHRPROC eglCreateImageKHR =
        (PFNEGLCREATEIMAGEKHRPROC)eglGetProcAddress("eglCreateImageKHR");
    PFNEGLDESTROYIMAGEKHRPROC eglDestroyImageKHR =
        (PFNEGLDESTROYIMAGEKHRPROC)eglGetProcAddress("eglDestroyImageKHR");
    // glEGLImageTargetTexture2DOES 原型在 gl2ext.h 中为 GLeglImageOES 版本
    void (*glEGLImageTargetTexture2DOES)(GLenum, GLeglImageOES) =
        (void (*)(GLenum, GLeglImageOES))eglGetProcAddress("glEGLImageTargetTexture2DOES");
    if (!eglCreateImageKHR || !eglDestroyImageKHR || !glEGLImageTargetTexture2DOES) {
        fprintf(stderr, "EGL image extensions missing\n");
        return 1;
    }

    // 查询驱动对目标 fourcc+modifier 的支持。external_ok 是严格验收条件，
    // 仅“出现在列表里”不能证明外部进程可以导入。
    PFNEGLQUERYDMABUFMODIFIERSEXTPROC eglQueryDmaBufModifiersEXT =
        (PFNEGLQUERYDMABUFMODIFIERSEXTPROC)eglGetProcAddress("eglQueryDmaBufModifiersEXT");
    int modifier_query_ok = 0;
    int selected_external_ok = 0;
    uint64_t selected_modifier = info.modifier;
    if (strcmp(mode, "linear") == 0) selected_modifier = DRM_FORMAT_MOD_LINEAR;
    if (eglQueryDmaBufModifiersEXT) {
        EGLuint64KHR mods[16];
        EGLBoolean ext_ok[16];
        EGLint nmods = 0;
        if (eglQueryDmaBufModifiersEXT(dpy, info.fourcc, 16, mods, ext_ok, &nmods)) {
            modifier_query_ok = 1;
            printf("dma_buf_import_modifiers: %d modifiers supported for fourcc=0x%08X\n",
                   nmods, info.fourcc);
            int found = 0;
            for (EGLint i = 0; i < nmods; i++) {
                printf("  mod[%d]=0x%016llX external_ok=%s\n", i,
                       (unsigned long long)mods[i], ext_ok[i] ? "yes" : "no");
                if (mods[i] == selected_modifier) {
                    found = 1;
                    selected_external_ok = ext_ok[i] ? 1 : 0;
                    printf("  -> 当前模式目标 modifier=%s, external_ok=%s\n",
                           mode, selected_external_ok ? "yes" : "no");
                }
            }
            if (!found && nmods > 0) {
                printf("  !!! 目标 modifier=0x%016llX 不在支持列表，EGL 导入将失败\n",
                       (unsigned long long)info.modifier);
            }
        } else {
            printf("eglQueryDmaBufModifiersEXT failed: 0x%x\n", eglGetError());
        }
    } else {
        printf("no eglQueryDmaBufModifiersEXT\n");
    }

    if (strcmp(mode, "original") == 0 &&
        (!modifier_query_ok || !selected_external_ok)) {
        fprintf(stderr, "IMPORT_VERDICT: FAIL mode=%s reason=modifier_not_external\n", mode);
        close(dmabuf);
        return 1;
    }

    struct timespec import_start, import_end;
    clock_gettime(CLOCK_MONOTONIC, &import_start);
    EGLImage img = import_dmabuf(dpy, eglCreateImageKHR, &info, dmabuf, mode);
    clock_gettime(CLOCK_MONOTONIC, &import_end);
    double import_time_ms = elapsed_ms(&import_start, &import_end);
    if (img == EGL_NO_IMAGE) {
        fprintf(stderr, "IMPORT_VERDICT: FAIL mode=%s import_ms=%.3f\n", mode, import_time_ms);
        close(dmabuf);
        return 1;
    } else {
        printf("imported mode=%s import_ms=%.3f\n", mode, import_time_ms);
    }

    // 绑定纹理 + 渲染到 FBO + 读像素
    GLuint tex, fbo;
    glGenTextures(1, &tex);
    glBindTexture(GL_TEXTURE_2D, tex);
    glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, img);
    GLuint tex_err = glGetError();
    if (tex_err != GL_NO_ERROR) {
        fprintf(stderr, "glEGLImageTargetTexture2DOES failed: 0x%x\n", tex_err);
        return 1;
    }

    glGenFramebuffers(1, &fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
    GLenum fb = glCheckFramebufferStatus(GL_FRAMEBUFFER);
    if (fb != GL_FRAMEBUFFER_COMPLETE) {
        fprintf(stderr, "framebuffer incomplete: 0x%x\n", fb);
        return 1;
    }

    // 读 RGBA（XB24 为 4 字节/像素 BGRX）
    size_t npx = (size_t)info.width * info.height;
    uint8_t *pixels = malloc(npx * 4);
    if (!pixels) return 1;
    memset(pixels, 0xAA, npx * 4);
    glFinish();
    glReadPixels(0, 0, info.width, info.height, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    GLenum rerr = glGetError();
    if (rerr != GL_NO_ERROR) {
        fprintf(stderr, "glReadPixels failed: 0x%x\n", rerr);
        return 1;
    }

    // 统计：非零像素、平均色、首个像素
    uint64_t nonblack = 0, sum = 0, nonzero_chan = 0;
    uint8_t first[4] = {0};
    memcpy(first, pixels, 4);
    for (size_t i = 0; i < npx; i++) {
        uint8_t r = pixels[i*4], g = pixels[i*4+1], b = pixels[i*4+2];
        sum += r + g + b;
        if (r || g || b) nonblack++;
        nonzero_chan += (r != 0) + (g != 0) + (b != 0);
    }
    printf("RESULT pixels=%zu nonblack=%llu (%.1f%%) avg_luma=%.1f nonzero_chan=%llu first_px=[%u,%u,%u,%u]\n",
           npx, (unsigned long long)nonblack,
           npx ? 100.0 * nonblack / npx : 0.0,
           npx ? (double)sum / npx : 0.0,
           (unsigned long long)nonzero_chan,
           first[0], first[1], first[2], first[3]);
    const char *verdict = nonblack > npx / 10 ? "PASS" : (nonblack > 0 ? "PARTIAL" : "FAIL");
    printf("IMPORT_VERDICT: %s mode=%s import_ms=%.3f pixels=%zu y0_top=%u fence=none\n",
           verdict, mode, import_time_ms, npx, info.y0_top);

    eglDestroyImageKHR(dpy, img);
    free(pixels);
    close(dmabuf);
    return nonblack > npx / 10 ? 0 : 1;
}
