<WhenPrompt as="request" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<If condition={!request.text.includes("explicit document")}><Fail message="The selected text did not reach the actual successor." /></If>
Saved raw reply with invalid JSON.
