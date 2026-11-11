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
FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e AS runtime

# Apply Alpine security fixes released since the base image was built. The
# digest pin keeps nginx itself fixed, but upstream rebuilds only every few
# weeks, and a CVE fixed in an Alpine package fails the Trivy scan until then.
# The image runs as UID 101, so switch to root for the upgrade and back after.
#
#
# Behind a TLS-intercepting proxy apk fails with "server certificate not
# trusted". Drop the proxy's CA (PEM, *.pem or *.crt) into trusted_certs/, or
# point TRUSTED_SSL_CERTS at another directory in the build context
# (`docker build --build-arg TRUSTED_SSL_CERTS=./my-certs .`); every file there
# is appended to the system CA bundle before apk runs. The committed directory
# is empty, so a build without one trusts the public CAs only.
ARG TRUSTED_SSL_CERTS=./trusted_certs
COPY $TRUSTED_SSL_CERTS /opt/certs/
USER root
RUN for CERT_PATH in /opt/certs/*.pem /opt/certs/*.crt; do \
      [ -e "$CERT_PATH" ] || continue; \
      { cat "$CERT_PATH"; echo; } >> /etc/ssl/certs/ca-certificates.crt; \
    done \
    && apk upgrade --no-cache
USER 101

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
