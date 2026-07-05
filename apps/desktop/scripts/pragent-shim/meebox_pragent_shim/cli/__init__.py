"""Local CLI provider: delegate review requests to a locally installed and authorized command-line tool to invoke the model on our behalf, bypassing litellm.
Per-command differences (argv / output parsing / billing env to strip) are centralized in specs.py, looked up by command name."""
