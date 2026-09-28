FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    COMPOSIO_CACHE_DIR=/tmp/composio-cache

WORKDIR /service
COPY pyproject.toml README.md LICENSE.iRock.md ./
COPY src ./src
RUN pip install . \
  && useradd --create-home --uid 10001 connector \
  && mkdir -p /tmp/composio-cache \
  && chown -R connector:connector /tmp/composio-cache

USER connector
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4317/health', timeout=4)"]

# One worker is deliberate: the tenant/toolkit connection lock is process-local.
CMD ["uvicorn", "rocky_connector.app:app", "--host", "0.0.0.0", "--port", "4317", "--workers", "1"]
