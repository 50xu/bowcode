FROM docker/sandbox-templates:claude-code

USER root
COPY shared/install-bowcode.sh /tmp/install-bowcode.sh
RUN chmod +x /tmp/install-bowcode.sh && /tmp/install-bowcode.sh

USER agent
# TODO(bowcode): build and package this fork before publishing sandbox images.
# The Bowcode CLI is not available from npm yet.

COPY --chown=agent:agent shared/start-bowcode.sh /home/agent/.bowcode-start.sh
RUN echo '. ~/.bowcode-start.sh' >> /home/agent/.bashrc
