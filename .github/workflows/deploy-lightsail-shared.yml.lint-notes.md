# #155 note

`actionlint` is run in CI on the edited `deploy-lightsail-shared.yml`. Locally
the editor step only verifies the diff is well-formed YAML; the shared
workflow's actual actionlint run is the CI step.
