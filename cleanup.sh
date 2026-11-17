#!/bin/bash
# Cleanup script for gw-mailbox GCP setup
# Use this to remove resources if needed

RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "🧹 gw-mailbox Cleanup"
echo "====================="
echo ""
echo -e "${YELLOW}WARNING: This will delete resources${NC}"
echo ""

if [ -z "${PROJECT_NAME:-}" ]; then
    read -r -p "Enter project name to cleanup: " PROJECT_NAME
fi

echo "Project: $PROJECT_NAME"
echo ""
echo "Choose cleanup level:"
echo "1. Delete service account keys only"
echo "2. Delete service account"
echo "3. Delete entire project (IRREVERSIBLE)"
echo "4. Cancel"
read -r -p "Enter choice (1-4): " CHOICE

SA_EMAIL="gw-mailbox-sa@$PROJECT_NAME.iam.gserviceaccount.com"

case $CHOICE in
    1)
        echo "Deleting service account keys..."
        gcloud iam service-accounts keys list \
            --iam-account="$SA_EMAIL" \
            --format="value(name)" | while read -r key; do
            gcloud iam service-accounts keys delete "$key" \
                --iam-account="$SA_EMAIL" --quiet
        done
        echo "✓ Keys deleted"
        ;;
    2)
        echo "Deleting service account..."
        gcloud iam service-accounts delete "$SA_EMAIL" --quiet
        echo "✓ Service account deleted"
        ;;
    3)
        echo -e "${RED}⚠️  WARNING: This will delete the entire project!${NC}"
        read -r -p "Type 'DELETE' to confirm: " CONFIRM
        if [ "$CONFIRM" = "DELETE" ]; then
            gcloud projects delete "$PROJECT_NAME" --quiet
            echo "✓ Project deleted"
        else
            echo "Cancelled"
        fi
        ;;
    *)
        echo "Cancelled"
        exit 0
        ;;
esac
