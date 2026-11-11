<WhenPrompt as="initial" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<Parse schema={{type:"object"}} as="input">{initial.text}</Parse>
<Json value={input.review} />
<If condition={input.variant !== "zero" && input.variant !== "invalid"}>
<WhenPrompt as="request" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<Let as="text" value={request.text.slice(request.text.indexOf('\n{')).trim()} />
<Parse schema={{type:"object"}} as="packet">{text}</Parse>
<If condition={packet.ordinal !== 1 || packet.remaining !== 0 || JSON.stringify(packet.result) !== JSON.stringify(input.review)}><Fail message="The correction changed the original result or allowance." /></If>
<Json value={{...packet.result,summary:input.variant === "exhausted" ? "x".repeat(1501) : "The independent findings and verdict remain unchanged.",...(input.variant === "changed" ? {verdict:"blocked"} : {})}} />
</If>
