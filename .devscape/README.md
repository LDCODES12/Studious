# tester shell boundary

This repository contains a mirrored copy of the venture interior.

- `.devscape/*` is reserved for shell-owned contracts and generated bridge files
- `venture/*` is the editable venture interior mirrored from Dev Scap
- the shell still owns money, roster, approvals, connected surfaces, and the canonical record

## Connection points

- shell: https://devscape-six.vercel.app/ventures/25c16408-b95b-41b0-82fe-e1bb8d39bfa3
- shell api: https://devscape-six.vercel.app/api/ventures/25c16408-b95b-41b0-82fe-e1bb8d39bfa3/shell
- interior source right now: Dev Scap database
- future mode: connected repo mirror or repo-owned interior

## Important

The venture can rewrite its own interface, prompts, and operating files.
It should not try to replace shell-owned UI like the venture frame, funding controls, or the back-to-venture navigation.
