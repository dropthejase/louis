#!/usr/bin/env bash
set -euo pipefail

STACK=${1:-DatabaseStack}

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
if ! command -v aws &>/dev/null; then
  echo "ERROR: aws CLI not found" && exit 1
fi
if ! aws sts get-caller-identity &>/dev/null; then
  echo "ERROR: No valid AWS credentials. Run 'aws configure' or set AWS_PROFILE." && exit 1
fi

# ---------------------------------------------------------------------------
# Resolve stack outputs
# ---------------------------------------------------------------------------
CLUSTER_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='ClusterArn'].OutputValue" --output text)
SECRET_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='SecretArn'].OutputValue" --output text)
DB_NAME=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='DatabaseName'].OutputValue" --output text)

if [[ -z "$CLUSTER_ARN" || "$CLUSTER_ARN" == "None" ]]; then
  echo "ERROR: Could not read ClusterArn from stack '$STACK'. Has it been deployed?" && exit 1
fi
if [[ -z "$SECRET_ARN" || "$SECRET_ARN" == "None" ]]; then
  echo "ERROR: Could not read SecretArn from stack '$STACK'." && exit 1
fi
if [[ -z "$DB_NAME" || "$DB_NAME" == "None" ]]; then
  echo "ERROR: Could not read DatabaseName from stack '$STACK'." && exit 1
fi

echo "Cluster : $CLUSTER_ARN"
echo "Database: $DB_NAME"
echo ""

SCHEMA_FILE="backend/migrations/000_one_shot_schema.sql"
if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "ERROR: Schema file not found: $SCHEMA_FILE (run from repo root)" && exit 1
fi

# ---------------------------------------------------------------------------
# Execute a single SQL statement against the cluster
# ---------------------------------------------------------------------------
run_sql() {
  local sql="$1"
  aws rds-data execute-statement \
    --resource-arn "$CLUSTER_ARN" \
    --secret-arn "$SECRET_ARN" \
    --database "$DB_NAME" \
    --sql "$sql" \
    --output json > /dev/null
}

# ---------------------------------------------------------------------------
# Parse the SQL file into individual statements.
#
# Rules:
#   - Strip single-line comments (-- ...)
#   - Accumulate lines into a buffer
#   - A line containing $$ toggles "inside dollar-quote" mode; the block
#     ends (and is flushed) only when the terminating $$; is seen
#   - Outside dollar-quote mode, flush the buffer whenever we hit a bare ;
# ---------------------------------------------------------------------------
stmt=""
in_dollar_quote=0

flush() {
  # Trim leading/trailing whitespace
  local s
  s=$(printf '%s' "$stmt" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  if [[ -n "$s" ]]; then
    echo "  >> ${s:0:80}$([ ${#s} -gt 80 ] && echo '...')"
    run_sql "$s"
  fi
  stmt=""
}

while IFS= read -r line; do
  # Strip single-line SQL comments (outside dollar-quoted blocks only)
  if [[ $in_dollar_quote -eq 0 ]]; then
    line=$(printf '%s' "$line" | sed 's/--.*$//')
  fi

  # Toggle dollar-quote mode when $$ appears on a line
  if printf '%s' "$line" | grep -q '\$\$'; then
    if [[ $in_dollar_quote -eq 0 ]]; then
      in_dollar_quote=1
      stmt="${stmt}"$'\n'"${line}"
      continue
    else
      # Closing $$  — append this line, then flush
      stmt="${stmt}"$'\n'"${line}"
      in_dollar_quote=0
      flush
      continue
    fi
  fi

  if [[ $in_dollar_quote -eq 1 ]]; then
    stmt="${stmt}"$'\n'"${line}"
    continue
  fi

  # Outside dollar-quote: split on semicolons within the line
  while [[ "$line" == *";"* ]]; do
    before="${line%%;*}"
    stmt="${stmt} ${before}"
    flush
    line="${line#*;}"
  done
  # Remainder (no more semicolons on this line)
  stmt="${stmt} ${line}"

done < "$SCHEMA_FILE"

# Flush any trailing statement without a terminating semicolon
flush

echo ""
echo "Schema init complete."
