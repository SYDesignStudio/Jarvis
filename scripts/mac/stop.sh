#!/bin/bash
# Stops the brain and the face on the Mac. (Restart from the Diagnostics panel keeps the launcher; this ends it.)
pkill -f "scripts/start.mjs" && echo "JARVIS stopped." || echo "JARVIS was not running."
