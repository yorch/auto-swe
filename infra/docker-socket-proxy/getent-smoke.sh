#!/bin/sh
if [ "$2" = broker.fixture ]; then
  printf '93.184.215.14 broker.fixture\n'
else
  exec /usr/bin/getent "$@"
fi
