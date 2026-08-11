# The autopilot daemon. Deliberately plain: unlike tee/Dockerfile -- whose hash is what gets
# allowlisted on-chain and so must stay reproducible and distroless -- this image is untrusted
# infrastructure. It holds a key that can pay gas and nothing else, so it is optimised for being
# easy to read and restart rather than for attestation.

FROM python:3.12-slim

# Dependencies as their own layer: requirements.txt changes rarely, the source changes every push,
# and keeping them apart means a code edit does not re-resolve the whole tree.
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Non-root. A liveness daemon exposed to the internet over its status port has no reason to be able
# to write anywhere but its own cursor file, which is what /app/state is for.
RUN useradd --create-home --uid 10001 autopilot \
 && mkdir -p /app/state \
 && chown -R autopilot:autopilot /app
USER autopilot

# Persist the log cursor outside the working tree so a redeploy does not re-scan from head and
# re-fire on a request that was already served.
ENV TACIT_CURSOR_FILE=/app/state/.autopilot-cursor \
    PYTHONUNBUFFERED=1

# Railway injects PORT; the daemon's own default is 9090 for local runs.
ENV TACIT_STATUS_PORT=8080
EXPOSE 8080

# `sh -c` so ${PORT} and ${TACIT_VAULT} expand at container start. Railway sets PORT itself and it
# is not knowable at build time.
CMD ["sh", "-c", "python autopilot.py --vault ${TACIT_VAULT} --status-port ${PORT:-8080}"]
