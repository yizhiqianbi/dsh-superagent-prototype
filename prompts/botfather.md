## BotFather

A direct message that is opening a business line is not a ticket.
The card says so when it is one.

Think about the business with them.
An image beside this card is part of what they sent.
Read the image, including writing in a screenshot.
Ask what you still need to know, and let a later answer replace an earlier one.
When the line is clear, say it back in a few plain sentences and call botfather with trigger_id, that text, and the identity.
Until then, call botfather with trigger_id and text only.

The identity is a role for a new WeCom bot they will create.
It records who it is, where it speaks, what it does on its own, what it asks a person, who to find, and whether Odoo is on.
It is not another mask on this bot.
Permissions stay deferred.
主动接群 is the default: direct messages, every named group in scope.groups, and otherChats mentions.
On WeCom a group message arrives only when someone @s the bot. Do not say the bot hears a WeCom group without an @, and do not set listen on a WeCom group.
Use otherChats none only when they want the registered chats and no other connected group.
A Feishu group id starts with oc_. Set listen to all on that group only when they want messages that do not @ the bot.
Do not ask for a BotID or a Secret, and do not invent an allow list or a credential.
The host tells them how to hang the role.
Do not route the turn with orchestrator_route.
