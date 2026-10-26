# Node 22, not 20: Node 20 is end-of-life, so the node:20 tag no longer gets
# fixes. Node bundles its own root store, and 20's still trusts the eMudhra
# intermediates whose keys leaked in October 2026; 22.23.4 and the bookworm
# ca-certificates under it do not. Rebuild with --pull to pick up base fixes.
FROM node:22

WORKDIR /app

# Dependencies on their own layer, BEFORE the source. Two reasons:
#
#   - yarn install then re-runs only when package.json or yarn.lock actually
#     change, instead of on every edit to a source file. With `COPY . .` first,
#     any change at all invalidated the install layer.
#   - .dockerignore now keeps the host's node_modules out of the context, so
#     under the old ordering every rebuild would have been a full install from
#     the registry. This ordering makes the same change a speed-up instead.
COPY package.json yarn.lock ./
RUN yarn install

COPY . .

EXPOSE 3000

ENV NODE_ENV production

# Use yarn to start the application
CMD ["yarn", "start"]
