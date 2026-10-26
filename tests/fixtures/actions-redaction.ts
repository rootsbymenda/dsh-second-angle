/** Synthetic credential examples and documented command-specific limits. */
export const redactionCases: readonly { input: string; secrets: readonly string[] }[] = [
  {
    "input": "curl -H \"Authorization: abcdef0123456789secretvalue\" https://x.invalid",
    "secrets": [
      "abcdef0123456789secretvalue"
    ]
  },
  {
    "input": "curl -H \"Authorization: Token abcdef0123456789\" https://x.invalid",
    "secrets": [
      "abcdef0123456789"
    ]
  },
  {
    "input": "curl -H \"Authorization: token ghp_abcdefghijklmnop1234\" https://x.invalid",
    "secrets": [
      "ghp_abcdefghijklmnop1234"
    ]
  },
  {
    "input": "curl -H \"Authorization: Digest username=\\\"u\\\", response=\\\"6629fae49393a05397450978507c4ef1\\\"\" https://x.invalid",
    "secrets": [
      "6629fae49393a05397450978507c4ef1"
    ]
  },
  {
    "input": "curl -H \"Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261026/us-east-1/s3/aws4_request, Signature=fe5f80f77d5fa3beca038a248ff027\" https://x.invalid",
    "secrets": [
      "AKIAIOSFODNN7EXAMPLE",
      "fe5f80f77d5fa3beca038a248ff027"
    ]
  },
  {
    "input": "curl -H \"X-Auth-Token: abcdef0123456789\" https://x.invalid",
    "secrets": [
      "abcdef0123456789"
    ]
  },
  {
    "input": "curl -H \"PRIVATE-TOKEN: glpat-abcdefghij123456\" https://gitlab.invalid",
    "secrets": [
      "glpat-abcdefghij123456"
    ]
  },
  {
    "input": "curl -su alice:hunter2 https://x.invalid",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "input": "curl --user=alice:hunter2 https://x.invalid",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "input": "curl -ualice:hunter2 https://x.invalid",
    "secrets": [
      "hunter2"
    ]
  },
  {
    "input": "git push -u origin main",
    "secrets": []
  },
  {
    "input": "python -u train.py --epochs 3",
    "secrets": []
  },
  {
    "input": "sort -u names.txt > out.txt",
    "secrets": []
  },
  {
    "input": "export DATABASE_URL=postgres://app:s3cretpw@db.internal:5432/app",
    "secrets": [
      "s3cretpw"
    ]
  },
  {
    "input": "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "secrets": [
      "AKIAIOSFODNN7EXAMPLE"
    ]
  },
  {
    "input": "export STRIPE_KEY=sk_live_abcdefghijklmnop",
    "secrets": [
      "sk_live_abcdefghijklmnop"
    ]
  },
  {
    "input": "export PRIVATE_KEY=\"-----BEGIN PRIVATE KEY-----MIIEv\"",
    "secrets": [
      "MIIEv"
    ]
  },
  {
    "input": "export GITHUB_PAT=github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
    "secrets": [
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"
    ]
  },
  {
    "input": "echo xoxb-1234567890-abcdefghij",
    "secrets": [
      "xoxb-1234567890-abcdefghij"
    ]
  },
  {
    "input": "curl -H \"Cookie: session=abcdef123456; csrftoken=zzz\" https://x.invalid",
    "secrets": [
      "abcdef123456",
      "zzz"
    ]
  },
  {
    "input": "mysql -h db -u root -pSup3rSecret app",
    "secrets": []
  },
  {
    "input": "sshpass -p hunter2 ssh user@host",
    "secrets": []
  },
  {
    "input": "{\"command\":\"curl -H \\\"X-Api-Key: abcdef123456\\\" https://x.invalid\"}",
    "secrets": [
      "abcdef123456"
    ]
  },
  {
    "input": "{\"token\":\"abc\",\"nested\":{\"password\":\"p4ss\"}}",
    "secrets": [
      "abc",
      "p4ss"
    ]
  }
]
