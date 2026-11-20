# Publish to Plinth

A GitHub Action that publishes a build folder, or one HTML or Markdown file, to
[Plinth](https://github.com/mr0b0t0/plinth) as the next version of an artifact. Each run adds a
version at the same link, so a report, a coverage page or a docs preview stays one URL that
always shows the latest build.

```yaml
- uses: mr0b0t0/plinth/publish@v0.6.0
  with:
    path: dist
    token: ${{ secrets.PLINTH_TOKEN }}
    id: k3x9mq2v7d8p4t6w1n5r
```

`k3x9mq2v7d8p4t6w1n5r` stands for your artifact's id.

Make the token on the Connections page: **New token**, then **Limit to one artifact**. It can only
read that artifact and publish new versions of it. The Action runs the CLI client from the same release, on
Linux and macOS runners, with nothing to install.

Inputs, outputs, GitLab CI, cron, pull requests from forks and what viewers see:
[docs/ci.md](../docs/ci.md).
