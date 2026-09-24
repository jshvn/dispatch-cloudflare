// jshvn/apartments -- watches apartment pricing pages. watch.yml reports new, gone and
// repriced units as a comment on its report issue, which is also where a failed run says
// so. It pings no healthcheck, by choice: a run this repo never starts goes unnoticed.
export default {
  repo: "jshvn/apartments",
  workflows: [{ workflow: "watch.yml", slots: ["every4h"] }],
} as const
