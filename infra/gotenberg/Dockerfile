# Gotenberg (headless LibreOffice + Chromium) with the fonts the course decks use: Hebrew (Culmus: David CLM,
# Frank Ruehl, Miriam), a Consolas-like monospace, and Noto for everything else. Metric substitutes for Calibri,
# Cambria, Arial, Times and Courier New (Carlito, Caladea, Liberation) ship with the base image.
FROM gotenberg/gotenberg:8
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-culmus fonts-inconsolata fonts-noto-core fontconfig \
  && rm -rf /var/lib/apt/lists/*
COPY fonts.conf /etc/fonts/conf.d/60-quire-aliases.conf
RUN fc-cache -f
USER gotenberg
