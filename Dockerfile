FROM node:alpine

ENV NODE_ENV strizhapp

COPY . /app
RUN rm -r -f /app/.git
WORKDIR /app
RUN npm install

EXPOSE 80;

CMD ["node", "app.js"]