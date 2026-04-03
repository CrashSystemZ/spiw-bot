FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -r -u 10001 -m spiw
WORKDIR /app

COPY pyproject.toml .
COPY spiw/ ./spiw/
RUN pip install --no-cache-dir .

RUN mkdir -p /app/data && chown spiw:spiw /app/data

USER spiw

CMD ["python", "-m", "spiw"]
