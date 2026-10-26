#!/bin/sh
# App Runner runs StartCommand as a single executable line, so shell operators
# must live in a script. Apply the Prisma migrations, then hand over to Node.
set -e
cd "$(dirname "$0")/server"
npx prisma migrate deploy
exec node dist/main
