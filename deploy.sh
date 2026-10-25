#!/usr/bin/env bash
# Deploy the built .deb to the target host and install it

DEPLOY_HOST="veve@lescayes"
DEPLOY_HOST_PATH="/tmp"
DEPLOY_PACKAGE="bibliograph_0.1.0_amd64.deb"

echo "Deploying $DEPLOY_PACKAGE to $DEPLOY_HOST..."

# Copy the .deb file to the remote host
scp -P 22 /home/vrgl/Code/olamaelcu/bibliograph/dist/bibliograph_0.1.0_amd64.deb \
  "$DEPLOY_HOST:$DEPLOY_HOST_PATH/$DEPLOY_PACKAGE"

echo "✓ Copied $DEPLOY_PACKAGE to $DEPLOY_HOST:$DEPLOY_HOST_PATH"

# Install the package and configure it
echo "Installing package on $DEPLOY_HOST..."
ssh -o BatchMode=yes "$DEPLOY_HOST" bash -c "
  sudo apt-get update -qq &&
  sudo apt-get install -y -qq /tmp/$DEPLOY_PACKAGE &&
  # Update DATABASE_URL in conffile if needed (package may have changed DB name)
  sudo sed -i 's/^DATABASE_URL=.*/DATABASE_URL=postgres:\\/\\/bibliograph:bibliograph@127.0.0.1:5432\\/bibliograph/' /etc/bibliograph/bibliograph.env ||
  echo 'Database configuration already correct'
"

echo "✓ Package installed on $DEPLOY_HOST"