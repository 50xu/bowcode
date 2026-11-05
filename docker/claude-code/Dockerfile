FROM docker/sandbox-templates:claude-code

USER root
COPY shared/install-bowcode.sh /tmp/install-bowcode.sh
RUN chmod +x /tmp/install-bowcode.sh && /tmp/install-bowcode.sh

RUN npm install -g --allow-scripts=bowcode,bcrypt,better-sqlite3,node-pty https://github.com/50xu/bowcode/releases/latest/download/bowcode.tgz

USER agent

COPY --chown=agent:agent shared/start-bowcode.sh /home/agent/.bowcode-start.sh
RUN echo '. ~/.bowcode-start.sh' >> /home/agent/.bashrc
