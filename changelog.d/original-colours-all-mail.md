### Fixed

- Dark mode no longer leaves dark text unreadable on mail that sets its own text colours but no background (the reader drops `bgcolor`): such mail is rendered light and inverted like mail with a background, with links still blue and text still grey. "Original colours" is offered above every adapted email, including quoted history, in every layout and at every width. It is a small button at the top right of the message body, reachable with the keyboard, with one fixed label and a pressed state.
