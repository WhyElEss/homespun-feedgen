FROM node:20

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
