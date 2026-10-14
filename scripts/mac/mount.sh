#!/bin/bash
# Mount the folders JARVIS shares with the PC. Safe to run again: mounted shares are left alone.
# The first time, macOS asks for the PC's (and the NAS's) user name and password — tick
# "Remember this password in my keychain" and it never asks again.
PC="${JARVIS_PC_HOST:-salman-pc.tail9831c4.ts.net}"
NAS="${JARVIS_NAS_HOST:-192.168.0.105}"

mount_share() { # host, share name
  local host="$1" share="$2" vol="/Volumes/$2"
  if mount | grep -q " on $vol (smbfs"; then echo "  $vol — mounted"; return 0; fi
  local url="smb://$host/${share// /%20}"
  if osascript -e "mount volume \"$url\"" >/dev/null 2>&1; then
    echo "  $vol — mounted now"
  else
    echo "  $vol — could not mount $url (is the PC on, and the folder shared?)"
    return 1
  fi
}

echo "Shared folders:"
mount_share "$PC" "APP DEVLOPMENT"
mount_share "$PC" "BUILDING REGULATIONS"
mount_share "$NAS" "salman_nas" || echo "    (the NAS needs the home network, or the PC's subnet route when you are out)"
