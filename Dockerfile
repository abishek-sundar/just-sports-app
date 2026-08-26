# JustSports — static site served by nginx. No build step, no runtime deps.
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html styles.css app.js sw.js manifest.webmanifest icon.svg /usr/share/nginx/html/

EXPOSE 80
