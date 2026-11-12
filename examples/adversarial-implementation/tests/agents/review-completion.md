<WhenPrompt as="initial" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<Parse schema={{type:"object"}} as="input">{initial.text}</Parse>

<If condition={input.variant === "unmarked"}>
The checks are still running.
<Else>
<Json value={{status:"in_progress"}} />
</Else>
</If>

<If condition={input.variant !== "unmarked"}>
<WhenPrompt as="completion" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<If condition={!completion.text.includes("Continue your unfinished independent review of " + input.review.revision)}><Fail message="Expected the continuation of the original review." /></If>
<If condition={input.variant === "repeat"}>
<Json value={{status:"in_progress"}} />
<Else>
<Json value={input.review} />
</Else>
</If>
</If>
<If condition={input.variant === "format"}>
<WhenPrompt as="correction" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<Let as="text" value={correction.text.slice(correction.text.indexOf('\n{')).trim()} />
<Parse schema={{type:"object"}} as="packet">{text}</Parse>
<If condition={packet.ordinal !== 1 || packet.remaining !== 0 || !packet.original.endsWith("/completion/raw.txt") || JSON.stringify(packet.result) !== JSON.stringify(input.review)}><Fail message="Expected the full formatting allowance and the completion verdict." /></If>
<Json value={{...input.review,summary:"Review complete."}} />
</If>
