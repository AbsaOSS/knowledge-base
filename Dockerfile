# Runtime image: nginx serving the prebuilt static site.
#
# nginx-unprivileged rather than the stock nginx image: this container serves
# static files on port 8080 and needs no privileged port, so there is no reason
# for the master process to run as root. This variant already listens on 8080
# and runs as UID 101.
#
# Pinned by digest, matching how every GitHub Action in .github/workflows is
# pinned. Dependabot bumps the tag; the digest keeps the deployment from moving
# underneath it in the meantime.
FROM nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0 AS runtime

# Overwrite the stock config rather than `RUN rm`-ing it: this image drops to a
# non-root user, which cannot delete files under /etc/nginx.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# The shared CORS + security header set, included by nginx.conf. Lives outside
# conf.d/ because nginx loads conf.d/*.conf as top-level server configuration
# and this is a fragment, not a server block.
COPY nginx.headers.conf /etc/nginx/kb-headers.conf

# `dist/` is built outside the image (npm run build / build:headless) and is not
# reproducible from this Dockerfile alone — see README. Fail loudly here rather
# than shipping an image that 404s, which is what a missing or half-built dist
# would otherwise produce at runtime.
COPY dist /usr/share/nginx/html
RUN test -f /usr/share/nginx/html/index.html \
 || (echo "dist/ has no index.html — run 'npm run build:headless' before docker build" >&2; exit 1)
RUN test -f /usr/share/nginx/html/style.css \
 || (echo "dist/ has no style.css — sub-app pages reference it via /__wf/knowledge-base/style.css" >&2; exit 1)

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
