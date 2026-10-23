#!/bin/sh
# Publish the BackOffice SPA to S3 behind CloudFront.
# App Runner only builds the API, so a client change needs this step.
set -e
BUCKET="${ADMIN_SPA_BUCKET:-learning-guide-admin-dev-851987565851}"
DIST_ID="${ADMIN_SPA_DISTRIBUTION_ID:-E2E9K78VZ45X8U}"
cd "$(dirname "$0")/../client"
npm ci
npm run build
aws s3 sync dist "s3://$BUCKET" --delete \
  --exclude index.html --exclude "*.html" \
  --cache-control "public,max-age=31536000,immutable"
aws s3 cp dist/index.html "s3://$BUCKET/index.html" --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/index.html" "/" >/dev/null
echo "published client/dist to s3://$BUCKET (CloudFront $DIST_ID)"
